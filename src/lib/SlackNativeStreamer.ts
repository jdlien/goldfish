import { webApi } from '@slack/bolt';
import { createChildLogger } from './logger.js';
import type { URLSource } from './toolSources.js';

type WebClient = webApi.WebClient;
type ChatStreamer = ReturnType<WebClient['chatStream']>;

/**
 * Map from Claude tool names to human-readable task labels.
 * Shown in Slack's native task timeline UI when streaming.
 */
/**
 * Maximum output chars shown in a task_update.output field.
 *
 * Kept small because every completed tool contributes this to the
 * native stream's cumulative payload, and Slack's `chat.appendStream`
 * has a much tighter per-message limit than regular chat.postMessage
 * (empirically ~8-12 KB including block overhead, not 40 KB).
 */
const MAX_TOOL_OUTPUT_CHARS = 400;

/**
 * Approximate cumulative payload size at which we preemptively roll over
 * to a fresh chatStream in the same thread. Slack rejects appends with
 * `msg_too_long` once the combined blocks+text size exceeds its limit;
 * rather than guess that limit exactly, we stay comfortably under it and
 * start a new message before hitting it. Reactive rollover on an actual
 * `msg_too_long` error is the safety net for bursts that jump the budget
 * in a single chunk.
 */
const ROLLOVER_THRESHOLD_BYTES = 8000;

/**
 * Start looking for a natural break point this many bytes before the
 * hard rollover threshold. Text arriving in the "soft zone" (between
 * SOFT and HARD thresholds) gets buffered until a newline appears,
 * then everything up to the newline is flushed and we roll over.
 * If the hard threshold is reached with no newline, force rollover.
 */
const ROLLOVER_SOFT_THRESHOLD_BYTES = 6500;

const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading file',
  Bash: 'Running command',
  Grep: 'Searching code',
  Glob: 'Finding files',
  Edit: 'Editing file',
  Write: 'Writing file',
  MultiEdit: 'Editing file',
  NotebookEdit: 'Editing notebook',
  WebFetch: 'Fetching page',
  WebSearch: 'Searching web',
  Agent: 'Delegating to agent',
  Task: 'Running task',
  TodoWrite: 'Updating tasks',
};

const logger = createChildLogger('SlackNativeStreamer');

/**
 * Streams a Claude response to Slack using the native streaming API
 * (chat.startStream / chat.appendStream / chat.stopStream).
 *
 * Slack's server renders the markdown natively during streaming —
 * including tables, headers, bold, links, and code blocks — so we
 * don't need any client-side formatting conversion. The SDK's
 * ChatStreamer handles byte-level buffering and throttling internally
 * (default 256 chars per API call).
 *
 * Requires a thread_ts: streaming is always threaded.
 *
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 * @see https://docs.slack.dev/ai/developing-ai-apps#streaming
 */
export class SlackNativeStreamer {
  private webClient: WebClient;
  private channel: string;
  private threadTs: string;
  private recipientTeamId: string | undefined;
  private recipientUserId: string | undefined;

  private streamer: ChatStreamer | null = null;
  /** Raw accumulated markdown (for transcript/DB persistence) */
  private rawText = '';
  /** Bytes of rawText that were confirmed sent to Slack (via successful append). */
  private confirmedSentBytes = 0;
  private stopped = false;
  /**
   * Approximate bytes written to the current streamer instance since
   * it was started (or since the last rollover). Used to decide when
   * to proactively roll over to a fresh chatStream to stay under
   * Slack's per-message cap. Reset on rollover.
   */
  private bytesInCurrentStream = 0;
  /** Text accumulated in the current stream segment (since last rollover). */
  private currentStreamText = '';
  /** Message ts of the current stream (captured from first append response). */
  private currentStreamTs: string | null = null;
  /**
   * When true, we've passed the soft threshold and are buffering text
   * waiting for a newline to split on before rolling over.
   */
  private seekingBreak = false;
  /**
   * Tool IDs currently shown as "in_progress" in the task timeline.
   * Maps toolId → title, so we can emit matching "complete" chunks when
   * text arrives or the stream finishes.
   */
  private pendingTools: Map<string, string> = new Map();

  /**
   * When false, all tool task_update chunks (in_progress / complete /
   * error) are suppressed — the native timeline stays empty and only
   * the assistant's text is streamed. Controlled by the GOLDFISH_SHOW_TOOLS
   * env var at the call site; defaults to true.
   */
  private showTools: boolean;

  constructor(
    webClient: WebClient,
    channel: string,
    threadTs: string,
    recipientTeamId?: string,
    recipientUserId?: string,
    showTools = true,
  ) {
    this.webClient = webClient;
    this.channel = channel;
    this.threadTs = threadTs;
    this.recipientTeamId = recipientTeamId;
    this.recipientUserId = recipientUserId;
    this.showTools = showTools;
  }

  /**
   * Create the ChatStreamer instance. Does not post anything yet — the
   * first chat.startStream call happens when the first append is made
   * (or when stop is called with text).
   */
  start(): void {
    this.streamer = this.webClient.chatStream({
      channel: this.channel,
      thread_ts: this.threadTs,
      // Larger buffer reduces the chance of Slack's renderer eating
      // newlines that fall on a flush boundary. Default is 256; 1024
      // means fewer, larger API calls — still well under rate limits.
      buffer_size: 1024,
      ...(this.recipientTeamId ? { recipient_team_id: this.recipientTeamId } : {}),
      ...(this.recipientUserId ? { recipient_user_id: this.recipientUserId } : {}),
    });
    logger.debug(
      {
        channel: this.channel,
        threadTs: this.threadTs,
        hasTeamId: Boolean(this.recipientTeamId),
        hasUserId: Boolean(this.recipientUserId),
      },
      'Native stream created',
    );
  }

  /**
   * Append raw markdown text to the stream. The SDK buffers internally
   * (default 256 chars) so there's no need to throttle on our side —
   * just pass text through as it arrives from Claude.
   *
   * If any tool tasks are still "in_progress" when text arrives, they're
   * marked complete first — a text_delta after a tool means the tool has
   * finished executing and Claude is now generating the response.
   */
  async appendText(markdown: string): Promise<void> {
    if (!this.streamer || this.stopped || !markdown) return;

    // Mark any in-progress tools complete before new text arrives
    if (this.pendingTools.size > 0) {
      await this.flushPendingToolsAsComplete();
    }

    // Soft threshold: start looking for a natural break point.
    // Text deltas from Claude are tiny (a few words each), so we can't
    // rely on finding a newline in the single chunk that crosses the
    // hard threshold. Instead, once we enter the "soft zone" (between
    // SOFT and HARD thresholds), check every incoming chunk for a newline.
    // When one arrives, flush everything up to the newline on the current
    // stream, roll over, and send the rest on the new stream.
    const projectedSize = this.bytesInCurrentStream + markdown.length;

    if (this.seekingBreak || projectedSize > ROLLOVER_SOFT_THRESHOLD_BYTES) {
      this.seekingBreak = true;

      // Look for a break in this chunk
      const paraIdx = markdown.lastIndexOf('\n\n');
      const lineIdx = markdown.lastIndexOf('\n');
      const breakIdx = paraIdx > 0 ? paraIdx : lineIdx > 0 ? lineIdx : -1;
      const breakLen = paraIdx > 0 ? 2 : 1; // \n\n vs \n

      if (breakIdx > 0) {
        // Found a break — split here
        const before = markdown.slice(0, breakIdx);
        const after = markdown.slice(breakIdx + breakLen);

        this.rawText += markdown;

        // Send the part before the break on the current stream
        if (before) {
          this.currentStreamText += before;
          try {
            await this.streamer!.append({ markdown_text: before });
            this.bytesInCurrentStream += before.length;
            this.confirmedSentBytes += before.length;
          } catch {
            // Partial send failed — will be handled by rollover
          }
        }
        // Credit separator bytes
        this.confirmedSentBytes += breakLen;

        await this.rollover();
        this.seekingBreak = false;

        // Send the part after the break on the new stream
        if (after) {
          this.currentStreamText += after;
          try {
            await this.streamer!.append({ markdown_text: after });
            this.bytesInCurrentStream += after.length;
            this.confirmedSentBytes += after.length;
          } catch (error) {
            logger.error({ error }, 'Failed to append remainder after smart rollover');
            throw error;
          }
        }
        return;
      }

      // No break found in this chunk. If we've hit the hard threshold,
      // force rollover (can't wait any longer or Slack will reject).
      if (projectedSize > ROLLOVER_THRESHOLD_BYTES) {
        await this.rollover();
        this.seekingBreak = false;
        // Fall through to normal append on the new stream
      }
      // Otherwise keep seeking — append normally and wait for next chunk
    }

    this.rawText += markdown;
    this.currentStreamText += markdown;
    try {
      await this.streamer!.append({ markdown_text: markdown });
      this.bytesInCurrentStream += markdown.length;
      this.confirmedSentBytes += markdown.length;
    } catch (error) {
      if (isRecoverableStreamError(error) && !this.stopped) {
        // Reactive rollover: Slack said the current stream is full or expired.
        // Open a fresh stream and retry the chunk once.
        logger.warn(
          { bytesInCurrentStream: this.bytesInCurrentStream },
          'Stream hit recoverable error; rolling over to a new chatStream',
        );
        await this.rollover();
        try {
          await this.streamer!.append({ markdown_text: markdown });
          this.bytesInCurrentStream += markdown.length;
          this.confirmedSentBytes += markdown.length;
          return;
        } catch (retryError) {
          logger.error(
            { error: retryError },
            'Append failed again after rollover; giving up',
          );
          throw retryError;
        }
      }
      logger.error({ error }, 'Failed to append to native stream');
      throw error;
    }
  }

  /**
   * Close the current chatStream cleanly and open a fresh one in the
   * same thread. The user sees the previous message finalize and a new
   * message appear right below it — continuing the response. Used both
   * proactively (to avoid hitting msg_too_long) and reactively (after
   * catching one).
   *
   * Tools that are still in_progress at rollover time are carried over:
   *
   *   1. On the OLD stream they're marked complete with a "(continued →)"
   *      title suffix so the handoff is explicit rather than leaving
   *      stranded spinners.
   *   2. `pendingTools` is preserved (not cleared).
   *   3. On the NEW stream, an in_progress chunk is re-emitted for each
   *      carried-over tool so that a later tool_result lands on a tool
   *      the new message's timeline already knows about — instead of
   *      appearing as an orphaned completion.
   */
  private async rollover(): Promise<void> {
    if (!this.streamer || this.stopped) return;

    // Snapshot pending tools before we touch either stream. We'll
    // finalize them on the old stream with a "(continued →)" suffix,
    // and re-emit them on the new stream.
    const carryOver = Array.from(this.pendingTools.entries());

    if (carryOver.length > 0) {
      try {
        await this.streamer.append({
          chunks: carryOver.map(([id, title]) => ({
            type: 'task_update' as const,
            id,
            title: `${title}…`,
            status: 'complete' as const,
          })),
        });
      } catch (error) {
        logger.warn(
          { error },
          'Failed to mark pending tools as continued on old stream during rollover',
        );
      }
    }

    const oldStreamer = this.streamer;
    try {
      await oldStreamer.stop();
    } catch (error) {
      logger.warn(
        { error },
        'Old stream failed to stop cleanly during rollover — continuing anyway',
      );
    }

    // Start a fresh stream in the same thread. Content appended from
    // here lands in a new Slack message right below the previous one.
    this.streamer = this.webClient.chatStream({
      channel: this.channel,
      thread_ts: this.threadTs,
      buffer_size: 1024,
      ...(this.recipientTeamId ? { recipient_team_id: this.recipientTeamId } : {}),
      ...(this.recipientUserId ? { recipient_user_id: this.recipientUserId } : {}),
    });
    this.bytesInCurrentStream = 0;
    this.currentStreamText = '';
    this.currentStreamTs = null;
    this.seekingBreak = false;

    // Re-emit in_progress for any carried-over tools on the new stream.
    // pendingTools stays populated (the tools are still running), so a
    // later tool_result will find them and finalize normally.
    if (carryOver.length > 0) {
      try {
        await this.streamer.append({
          chunks: carryOver.map(([id, title]) => ({
            type: 'task_update' as const,
            id,
            title,
            status: 'in_progress' as const,
          })),
        });
        this.bytesInCurrentStream += carryOver.reduce(
          (sum, [, title]) => sum + title.length + 80,
          0,
        );
      } catch (error) {
        logger.warn(
          { error },
          'Failed to re-emit carried-over tools on new stream — subsequent tool_results may appear orphaned',
        );
      }
    }

    logger.info(
      { carriedOverTools: carryOver.length },
      'Rolled over to fresh chatStream in same thread',
    );
  }

  /**
   * Signal that a tool call has started. Sends a task_update chunk with
   * status "in_progress" — Slack renders this as a native timeline entry
   * with a spinner. Chunks bypass the SDK's text buffer, so the status
   * appears immediately.
   *
   * The tool stays "in_progress" until the next text_delta, the next
   * tool_start, or finish() — whichever comes first. Completing previous
   * tools on new tool_start handles the common case of sequential tool
   * calls across multiple Claude turns with no intervening text.
   */
  async startTool(toolId: string, toolName: string): Promise<void> {
    if (!this.streamer || this.stopped || !toolId) return;
    // Tool visibility is off — skip the task_update entirely. Assistant
    // text still streams via appendText; only the native timeline entry
    // is suppressed.
    if (!this.showTools) return;

    // Complete any previously-pending tools first — a new tool starting
    // means prior tools have finished executing (even if there was no
    // text between them).
    if (this.pendingTools.size > 0) {
      await this.flushPendingToolsAsComplete();
    }

    const title = TOOL_LABELS[toolName] ?? `Using ${toolName}`;
    // Approximate size of the in_progress chunk: title + a bit of JSON
    // overhead. Roll over if it would tip us past the threshold.
    const approxBytes = title.length + 80;
    if (this.bytesInCurrentStream + approxBytes > ROLLOVER_THRESHOLD_BYTES) {
      await this.rollover();
    }
    this.pendingTools.set(toolId, title);
    try {
      await this.streamer!.append({
        chunks: [
          {
            type: 'task_update',
            id: toolId,
            title,
            status: 'in_progress',
          },
        ],
      });
      this.bytesInCurrentStream += approxBytes;
    } catch (error) {
      if (isRecoverableStreamError(error) && !this.stopped) {
        logger.warn(
          { toolId, toolName },
          'startTool hit recoverable stream error; rolling over',
        );
        // rollover() carries pendingTools across AND re-emits an
        // in_progress chunk for this tool on the new stream, so no
        // retry is needed here — if we tried to send in_progress again
        // we'd double-render the timeline entry.
        await this.rollover();
        return;
      }
      logger.error({ error, toolId, toolName }, 'Failed to send task_update in_progress chunk');
      // Don't throw — tool status is a nicety, not critical to the response
      this.pendingTools.delete(toolId);
    }
  }

  /**
   * Complete a specific tool with its actual output. Called when a
   * tool_result event arrives from the stream — this is the most accurate
   * timing, and lets us include the real stdout/stderr in the task
   * timeline entry (via the `output` field).
   */
  async completeToolWithOutput(
    toolId: string,
    output: string,
    isError: boolean,
    sources?: URLSource[],
  ): Promise<void> {
    if (!this.streamer || this.stopped || !toolId) return;
    // Tool visibility is off — matching startTool's early-return so we
    // never emit a completion for a task we never started.
    if (!this.showTools) return;

    const title = this.pendingTools.get(toolId);
    if (!title) {
      // Tool wasn't in our pending set — might have been completed already
      // by a later tool_start (auto-complete). Still emit the output so the
      // timeline entry gets the final data.
      logger.debug({ toolId }, 'tool_result for unknown toolId — sending anyway');
    }

    const truncated = truncateOutput(output);
    const hasSources = sources && sources.length > 0;
    // Approximate payload size for budget tracking: title + truncated
    // output + sources (as a rough proxy, URL lengths) + JSON overhead.
    const approxBytes =
      (title?.length ?? 8) +
      truncated.length +
      (sources?.reduce((sum, s) => sum + (s.url?.length ?? 0), 0) ?? 0) +
      120;

    // Proactive rollover: if this completion would tip us past the
    // threshold, rollover first. pendingTools still has this tool, so
    // rollover will carry it over to the new stream as in_progress and
    // we'll finalize it below on the new stream.
    if (this.bytesInCurrentStream + approxBytes > ROLLOVER_THRESHOLD_BYTES) {
      await this.rollover();
    }

    const buildChunk = () => ({
      type: 'task_update' as const,
      id: toolId,
      title: title ?? 'Tool',
      status: (isError ? 'error' : 'complete') as 'error' | 'complete',
      ...(truncated ? { output: truncated } : {}),
      ...(hasSources ? { sources } : {}),
    });

    try {
      await this.streamer!.append({ chunks: [buildChunk()] });
      this.bytesInCurrentStream += approxBytes;
      this.pendingTools.delete(toolId);
    } catch (error) {
      if (isRecoverableStreamError(error) && !this.stopped) {
        logger.warn(
          { toolId },
          'completeToolWithOutput hit recoverable stream error; rolling over and retrying',
        );
        // pendingTools still has this tool (we only delete on success),
        // so rollover() will re-emit in_progress for it on the new stream.
        // The retry then just sends the complete chunk.
        await this.rollover();
        try {
          await this.streamer!.append({ chunks: [buildChunk()] });
          this.bytesInCurrentStream += approxBytes;
          this.pendingTools.delete(toolId);
          return;
        } catch (retryError) {
          logger.error(
            { error: retryError, toolId },
            'completeToolWithOutput failed again after rollover; dropping',
          );
          this.pendingTools.delete(toolId);
          return;
        }
      }
      logger.error({ error, toolId }, 'Failed to send tool_result task_update');
      // Non-critical — drop from pendingTools so it doesn't accidentally
      // get carried over on a later rollover.
      this.pendingTools.delete(toolId);
    }
  }

  /**
   * Mark all pending tools as complete. Used internally when text arrives
   * (indicating tools have finished) or when the stream finishes.
   */
  private async flushPendingToolsAsComplete(): Promise<void> {
    if (!this.streamer || this.stopped || this.pendingTools.size === 0) return;
    // With tool visibility off, pendingTools should never be populated
    // (startTool early-returns before touching the map), but guard anyway.
    if (!this.showTools) {
      this.pendingTools.clear();
      return;
    }
    const chunks = Array.from(this.pendingTools.entries()).map(
      ([id, title]) => ({
        type: 'task_update' as const,
        id,
        title,
        status: 'complete' as const,
      }),
    );
    this.pendingTools.clear();
    try {
      await this.streamer.append({ chunks });
    } catch (error) {
      logger.error({ error }, 'Failed to send task_update complete chunks');
      // Non-critical — continue
    }
  }

  /**
   * Finalize the stream. Optionally include a final markdown text —
   * if provided, it's passed to stop() directly (not as a separate
   * append) which ensures it's included in the same API call.
   */
  async finish(finalMarkdown?: string): Promise<void> {
    if (!this.streamer || this.stopped) return;

    // Complete any tools still shown as in_progress
    if (this.pendingTools.size > 0) {
      await this.flushPendingToolsAsComplete();
    }

    this.stopped = true;
    try {
      if (finalMarkdown) {
        this.rawText += finalMarkdown;
        this.currentStreamText += finalMarkdown;
      }

      // Flush the SDK's internal buffer before stopping. Passing an empty
      // chunks array forces the SDK to send any buffered markdown_text via
      // appendStream. Then a short delay lets Slack's backend finish
      // processing the append before we finalize with stopStream.
      // Without this, stopStream can race with pending appends and the
      // finalized message renders truncated (observed on both iOS and desktop).
      try {
        if (finalMarkdown) {
          await this.streamer.append({ markdown_text: finalMarkdown, chunks: [] });
        } else {
          await this.streamer.append({ chunks: [] });
        }
      } catch {
        // Buffer may already be empty — not critical
      }
      await new Promise((resolve) => setTimeout(resolve, 200));

      await this.streamer.stop();
      logger.debug('Native stream stopped');
    } catch (error) {
      // If the stream was already finalized by Slack (e.g. due to inactivity
      // during a long tool execution), don't throw — the message was already
      // delivered. Post any final text as a regular message instead.
      if (isNotInStreamingState(error)) {
        logger.warn('Stream already finalized by Slack — posting final text as regular message');
        if (finalMarkdown) {
          try {
            await this.webClient.chat.postMessage({
              channel: this.channel,
              text: finalMarkdown,
              thread_ts: this.threadTs,
            });
          } catch (postError) {
            logger.error({ error: postError }, 'Fallback postMessage for final text also failed');
          }
        }
        return;
      }
      logger.error({ error }, 'Failed to stop native stream');
      throw error;
    }
  }

  /**
   * Abort the stream with an error message. Tries to stop the stream
   * cleanly; if that fails (or the stream never started), falls back
   * to a regular chat.postMessage so the user still sees the error.
   */
  async abort(errorText: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Try to stop the native stream cleanly
    if (this.streamer) {
      try {
        await this.streamer.stop({ markdown_text: errorText });
        logger.debug('Native stream aborted via stop()');
        return;
      } catch (error) {
        logger.error(
          { error },
          'Failed to stop native stream; falling back to postMessage',
        );
        // Fall through to the postMessage fallback
      }
    }

    // Fallback: post a regular message so the user sees something
    try {
      await this.webClient.chat.postMessage({
        channel: this.channel,
        text: errorText,
        thread_ts: this.threadTs,
      });
      logger.debug('Abort fallback posted via chat.postMessage');
    } catch (postError) {
      logger.error(
        { error: postError },
        'Fallback chat.postMessage also failed — user will see nothing',
      );
    }
  }

  /**
   * Get the accumulated raw markdown for transcript/DB persistence.
   * This is the unfiltered text as Claude emitted it, not the rendered
   * Slack output.
   */
  getRawText(): string {
    return this.rawText;
  }

  /**
   * Get the portion of rawText that was NOT confirmed sent to Slack.
   * When a stream dies mid-response (e.g. Slack auto-finalizes during
   * a long tool call), this returns the text the user never saw.
   */
  getUnsentText(): string {
    return this.rawText.slice(this.confirmedSentBytes);
  }

  /**
   * True once stop() or abort() has been called.
   */
  isStopped(): boolean {
    return this.stopped;
  }
}

/**
 * True if the error is Slack's `msg_too_long` platform error. The Slack
 * Bolt/web-api SDK throws these as `Error` with message
 * "An API error occurred: msg_too_long" and/or `data.error === 'msg_too_long'`.
 * Matching on either path keeps us robust to SDK version changes.
 */
function isMsgTooLong(error: unknown): boolean {
  return isSlackPlatformError(error, 'msg_too_long');
}

/**
 * True if the error is Slack's `message_not_in_streaming_state` error.
 * This occurs when Slack auto-finalizes a stream due to inactivity (e.g.
 * during a long tool execution) and we try to append/stop afterward.
 */
function isNotInStreamingState(error: unknown): boolean {
  return isSlackPlatformError(error, 'message_not_in_streaming_state');
}

/**
 * True if the error is a recoverable streaming error — one where rolling
 * over to a fresh stream is the right response.
 */
function isRecoverableStreamError(error: unknown): boolean {
  return isMsgTooLong(error) || isNotInStreamingState(error);
}

/**
 * Find the best break point in a text chunk for splitting a message.
 * Prefers paragraph breaks (\n\n), falls back to single newlines (\n).
 * Returns { before, after } where `before` goes to the current stream
 * and `after` goes to the new stream. If no break is found, `before`
 * is empty and `after` is the full text (force rollover).
 */
function splitAtBreak(text: string): { before: string; after: string } {
  // Prefer paragraph break (double newline)
  const paraIdx = text.lastIndexOf('\n\n');
  if (paraIdx > 0) {
    return {
      before: text.slice(0, paraIdx),
      after: text.slice(paraIdx + 2), // skip the \n\n
    };
  }

  // Fall back to single newline
  const lineIdx = text.lastIndexOf('\n');
  if (lineIdx > 0) {
    return {
      before: text.slice(0, lineIdx),
      after: text.slice(lineIdx + 1), // skip the \n
    };
  }

  // No break found — whole chunk goes to the new stream
  return { before: '', after: text };
}

/**
 * Check if an error matches a specific Slack platform error code.
 */
function isSlackPlatformError(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { message?: unknown; data?: { error?: unknown } };
  if (typeof err.message === 'string' && err.message.includes(code)) {
    return true;
  }
  if (err.data && typeof err.data === 'object' && err.data.error === code) {
    return true;
  }
  return false;
}

/**
 * Truncate tool output for display in a task_update.output field. Keeps
 * the head of the output (usually the most relevant part) and appends a
 * truncation marker.
 */
function truncateOutput(output: string): string {
  if (!output) return '';
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  const truncated = output.slice(0, MAX_TOOL_OUTPUT_CHARS);
  const dropped = output.length - MAX_TOOL_OUTPUT_CHARS;
  return `${truncated}\n… (${dropped} more chars truncated)`;
}
