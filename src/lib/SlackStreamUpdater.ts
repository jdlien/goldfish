import type { SlackBoltClient } from '../adapters/SlackBoltClient.js';
import { formatForSlack, splitSlackMessage } from './slackFormatter.js';
import { createChildLogger } from './logger.js';
import { STREAM_UPDATE_INTERVAL_MS } from '../config.js';

const logger = createChildLogger('SlackStreamUpdater');

const TOOL_LABELS: Record<string, string> = {
  Read: '📖 _Reading file..._',
  Bash: '⚙️ _Running command..._',
  Grep: '🔍 _Searching..._',
  Glob: '📁 _Finding files..._',
  Edit: '✏️ _Editing file..._',
  Write: '📝 _Writing file..._',
  WebFetch: '🌐 _Fetching page..._',
  WebSearch: '🔍 _Searching web..._',
  Agent: '🤖 _Delegating to agent..._',
};

const SLACK_MSG_LIMIT = 3900;
const TYPING_CURSOR = '▍';
const MAX_UPDATE_INTERVAL_MS = 5000;

/**
 * Manages progressive Slack message updates during Claude streaming.
 *
 * Posts an initial message, then throttle-updates it as tokens arrive.
 * Handles tool status indicators, typing cursor, rate limits, and
 * message splitting for long responses.
 */
export class SlackStreamUpdater {
  private slackClient: SlackBoltClient;
  private channel: string;
  private threadTs: string | undefined;

  /** Raw markdown accumulated from text_delta events */
  private rawText = '';
  /** The formatted text we last sent to Slack */
  private lastSentText = '';
  /** Current tool status label (null = no tool active) */
  private toolStatus: string | null = null;
  /** Timestamps of messages we've posted (for multi-message splitting) */
  private messageTimestamps: string[] = [];
  /** Text already "committed" to earlier messages (split off) */
  private committedLength = 0;

  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private updateIntervalMs: number;
  private finished = false;
  /** In-flight tick promise — awaited before final update to prevent races */
  private pendingTick: Promise<void> | null = null;

  constructor(
    slackClient: SlackBoltClient,
    channel: string,
    threadTs?: string,
    updateIntervalMs?: number,
  ) {
    this.slackClient = slackClient;
    this.channel = channel;
    this.threadTs = threadTs;
    this.updateIntervalMs = updateIntervalMs ?? STREAM_UPDATE_INTERVAL_MS;
  }

  /**
   * Start the update timer.
   *
   * Does NOT post an initial message — we lazy-post on first real content
   * (text_delta or tool_start) to avoid a "Thinking..." flash and minimize
   * the number of chat.update calls (which produce "(edited)" tags).
   */
  async start(): Promise<void> {
    this.startTimer();
  }

  /**
   * Append raw markdown text from a text_delta event.
   * Text arriving means a new text-generation phase has started,
   * so clear any stale tool status.
   */
  appendText(text: string): void {
    if (this.toolStatus) {
      this.toolStatus = null;
    }
    this.rawText += text;
  }

  /**
   * Set the current tool status indicator.
   * Pass null to clear (tool finished).
   *
   * Note: for tool_start events, prefer calling this then immediately
   * calling tickNow() so the label appears without waiting for the timer.
   */
  setToolStatus(toolName: string | null): void {
    if (toolName === null) {
      this.toolStatus = null;
    } else {
      this.toolStatus = TOOL_LABELS[toolName] ?? `🔧 _Using ${toolName}..._`;
    }
  }

  /**
   * Trigger an immediate message update (bypass the timer).
   * Useful when tool status changes — we want the label visible right away.
   */
  async tickNow(): Promise<void> {
    if (this.pendingTick) {
      await this.pendingTick;
    }
    this.pendingTick = this.tick().finally(() => {
      this.pendingTick = null;
    });
    await this.pendingTick;
  }

  /**
   * Finish streaming — do a final chat.update with the complete formatted text.
   * If the response needs splitting, update the current message and post
   * additional chunks as new messages.
   */
  async finish(finalFormattedText: string): Promise<void> {
    this.finished = true;
    this.stopTimer();

    // Wait for any in-flight tick to complete so our final update isn't
    // raced by a stale cursor-containing update still in flight.
    if (this.pendingTick) {
      await this.pendingTick;
    }

    const currentTs = this.currentMessageTs();
    if (!currentTs) {
      // Never posted anything — just post the final result
      const chunks = splitSlackMessage(finalFormattedText);
      for (const chunk of chunks) {
        const sendResult = await this.slackClient.sendMessage({
          channel: this.channel,
          text: chunk,
          threadTs: this.threadTs,
        });
        if (sendResult.ok) {
          this.messageTimestamps.push(sendResult.value);
        }
      }
      return;
    }

    const pendingText = finalFormattedText.slice(this.committedLength);
    if (pendingText.length <= SLACK_MSG_LIMIT) {
      // Fits in current message — just update it
      await this.doUpdate(currentTs, pendingText || finalFormattedText);
    } else {
      // Split remaining text across messages
      const chunks = splitSlackMessage(pendingText);

      // Update current message with first chunk
      await this.doUpdate(currentTs, chunks[0]);

      // Post remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        const sendResult = await this.slackClient.sendMessage({
          channel: this.channel,
          text: chunks[i],
          threadTs: this.threadTs,
        });
        if (sendResult.ok) {
          this.messageTimestamps.push(sendResult.value);
        }
      }
    }
  }

  /**
   * Abort streaming with an error message.
   * Updates the current message in place, or posts fresh if none exists.
   */
  async abort(errorText: string): Promise<void> {
    this.finished = true;
    this.stopTimer();

    // Wait for any in-flight tick to avoid race conditions
    if (this.pendingTick) {
      await this.pendingTick;
    }

    const currentTs = this.currentMessageTs();
    if (currentTs) {
      await this.doUpdate(currentTs, errorText);
    } else {
      const sendResult = await this.slackClient.sendMessage({
        channel: this.channel,
        text: errorText,
        threadTs: this.threadTs,
      });
      if (sendResult.ok) {
        this.messageTimestamps.push(sendResult.value);
      }
    }
  }

  /**
   * Get the accumulated raw text (for saving to transcript).
   */
  getRawText(): string {
    return this.rawText;
  }

  /**
   * Get all message timestamps posted by this updater.
   */
  getMessageTimestamps(): string[] {
    return [...this.messageTimestamps];
  }

  private currentMessageTs(): string | undefined {
    return this.messageTimestamps[this.messageTimestamps.length - 1];
  }

  private startTimer(): void {
    this.updateTimer = setInterval(() => {
      // Skip if a previous tick is still in flight — prevents overlapping
      // HTTP calls and out-of-order Slack updates.
      if (this.pendingTick) return;
      this.pendingTick = this.tick().finally(() => {
        this.pendingTick = null;
      });
    }, this.updateIntervalMs);
  }

  private stopTimer(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.finished) return;

    // Format the current raw text
    const formatted = formatForSlack(this.rawText);
    const pendingText = formatted.slice(this.committedLength);

    // Build display text from text + tool status
    let displayText = '';
    if (pendingText) {
      displayText = pendingText + TYPING_CURSOR;
    }
    if (this.toolStatus) {
      displayText = displayText
        ? this.toolStatus + '\n' + displayText
        : this.toolStatus;
    }

    // Nothing to show yet — don't post anything. This avoids the
    // "Thinking..." flash before real content arrives.
    if (!displayText) return;

    const currentTs = this.currentMessageTs();

    // Lazy post: first meaningful content → post initial message
    if (!currentTs) {
      const sendResult = await this.slackClient.sendMessage({
        channel: this.channel,
        text: displayText,
        threadTs: this.threadTs,
      });
      if (sendResult.ok) {
        this.messageTimestamps.push(sendResult.value);
        this.lastSentText = displayText;
      } else {
        logger.error({ error: sendResult.error }, 'Failed to post initial streaming message');
      }
      return;
    }

    // Check if we need to split mid-stream
    if (pendingText.length > SLACK_MSG_LIMIT) {
      const splitPoint = this.findSplitPoint(pendingText);
      const committedChunk = pendingText.slice(0, splitPoint);

      // Finalize current message (no cursor)
      await this.doUpdate(currentTs, committedChunk);
      this.committedLength += splitPoint;

      // Start new message (will be lazy-posted on next tick when more content arrives)
      this.lastSentText = '';
      return;
    }

    // Subsequent update — only if content changed
    if (displayText === this.lastSentText) return;

    await this.doUpdate(currentTs, displayText);
    this.lastSentText = displayText;
  }

  private async doUpdate(ts: string, text: string): Promise<void> {
    const result = await this.slackClient.updateMessage({
      channel: this.channel,
      ts,
      text,
    });

    if (!result.ok) {
      const errorMsg = result.error.message;
      // Rate limit — back off
      if (errorMsg.includes('rate') || errorMsg.includes('429')) {
        this.updateIntervalMs = Math.min(
          this.updateIntervalMs * 2,
          MAX_UPDATE_INTERVAL_MS,
        );
        this.stopTimer();
        this.startTimer();
        logger.warn(
          { newIntervalMs: this.updateIntervalMs },
          'Rate limited, backing off update interval',
        );
      } else {
        logger.error({ error: result.error }, 'Failed to update streaming message');
      }
    }
  }

  private findSplitPoint(text: string): number {
    const slice = text.slice(0, SLACK_MSG_LIMIT);
    let splitAt = slice.lastIndexOf('\n\n');
    if (splitAt < SLACK_MSG_LIMIT * 0.3) splitAt = slice.lastIndexOf('\n');
    if (splitAt < SLACK_MSG_LIMIT * 0.3) splitAt = slice.lastIndexOf(' ');
    if (splitAt < SLACK_MSG_LIMIT * 0.3) splitAt = SLACK_MSG_LIMIT;
    return splitAt;
  }
}
