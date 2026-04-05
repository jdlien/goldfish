import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('StreamEventParser');

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; toolName: string; toolId: string }
  | { type: 'tool_end'; toolId: string }
  | {
      type: 'tool_result';
      toolId: string;
      toolName?: string;
      toolInput?: unknown;
      output: string;
      isError: boolean;
    }
  | { type: 'result'; result: string; sessionId: string; costUsd?: number; numTurns?: number; durationMs?: number }
  | { type: 'error'; message: string };

/**
 * Parses newline-delimited JSON from Claude CLI's stream-json output
 * into typed StreamEvent objects.
 */
export class StreamEventParser {
  private buffer = '';
  private currentToolId: string | null = null;
  /** True once any text_delta has been emitted (for turn separator logic) */
  private hasEmittedText = false;
  /** Set when a new assistant message starts mid-stream; causes the next
   *  text_delta to be prefixed with a blank-line separator so multi-turn
   *  responses (text → tool use → text) don't render as run-together text. */
  private pendingTurnSeparator = false;
  /** Tool metadata captured from assistant snapshots — used to enrich
   *  tool_result events with the tool's name and input (needed for
   *  WebFetch URL extraction and source citations). */
  private toolInfo: Map<string, { name: string; input: unknown }> = new Map();
  private callback: (event: StreamEvent) => void;

  constructor(callback: (event: StreamEvent) => void) {
    this.callback = callback;
  }

  /**
   * Feed a chunk of data from stdout. May contain partial lines.
   */
  feed(chunk: string): void {
    this.buffer += chunk;

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;
      this.parseLine(line);
    }
  }

  /**
   * Flush any remaining buffered data (call when stream ends).
   */
  flush(): void {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line.length > 0) {
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line);
    } catch {
      logger.debug({ line: line.substring(0, 200) }, 'Skipping non-JSON line');
      return;
    }

    const type = json.type as string;

    if (type === 'stream_event') {
      this.handleStreamEvent(json.event as Record<string, unknown>);
    } else if (type === 'user') {
      // User messages in the stream carry tool_result content blocks that
      // link back to tool_use_id from an earlier assistant turn. Emit one
      // tool_result event per result so the streamer can mark the
      // corresponding task as complete with its output.
      this.handleUserMessage(json.message as Record<string, unknown> | undefined);
    } else if (type === 'assistant') {
      // Assistant snapshots contain the complete tool_use blocks with
      // their full input (the input_json_delta events stream the input
      // incrementally, but the snapshot has it all assembled). We use
      // this to capture tool metadata for later tool_result enrichment.
      this.handleAssistantMessage(json.message as Record<string, unknown> | undefined);
    } else if (type === 'result') {
      this.callback({
        type: 'result',
        result: (json.result as string) ?? '',
        sessionId: (json.session_id as string) ?? '',
        costUsd: json.total_cost_usd as number | undefined,
        numTurns: json.num_turns as number | undefined,
        durationMs: json.duration_ms as number | undefined,
      });
    }
    // Ignore: system, assistant (snapshots), rate_limit_event
  }

  private handleAssistantMessage(message: Record<string, unknown> | undefined): void {
    if (!message) return;
    const content = message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'tool_use'
      ) {
        const b = block as Record<string, unknown>;
        const id = b.id as string | undefined;
        const name = b.name as string | undefined;
        const input = b.input;
        if (id && name && input !== undefined) {
          this.toolInfo.set(id, { name, input });
        }
      }
    }
  }

  private handleUserMessage(message: Record<string, unknown> | undefined): void {
    if (!message) return;
    const content = message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'tool_result'
      ) {
        const b = block as Record<string, unknown>;
        const toolId = (b.tool_use_id as string) ?? '';
        const isError = b.is_error === true;

        // The content field can be a string or an array of content blocks.
        // Normalize to a string.
        let output = '';
        const rawContent = b.content;
        if (typeof rawContent === 'string') {
          output = rawContent;
        } else if (Array.isArray(rawContent)) {
          output = rawContent
            .map((c) => {
              if (typeof c === 'string') return c;
              if (c && typeof c === 'object' && 'text' in c) {
                return String((c as Record<string, unknown>).text ?? '');
              }
              return '';
            })
            .join('');
        }

        if (toolId) {
          const info = this.toolInfo.get(toolId);
          this.callback({
            type: 'tool_result',
            toolId,
            toolName: info?.name,
            toolInput: info?.input,
            output,
            isError,
          });
        }
      }
    }
  }

  private handleStreamEvent(event: Record<string, unknown>): void {
    const eventType = event.type as string;

    switch (eventType) {
      case 'message_start': {
        // A new assistant message (turn) is starting. If we've already
        // emitted text earlier in the stream, the next text_delta should
        // be separated from the previous turn's text with a blank line.
        if (this.hasEmittedText) {
          this.pendingTurnSeparator = true;
        }
        break;
      }

      case 'content_block_start': {
        const block = event.content_block as Record<string, unknown>;
        if (block?.type === 'tool_use') {
          const toolId = (block.id as string) ?? '';
          const toolName = (block.name as string) ?? '';
          this.currentToolId = toolId;
          this.callback({ type: 'tool_start', toolName, toolId });
        }
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown>;
        if (delta?.type === 'text_delta') {
          const raw = (delta.text as string) ?? '';
          if (raw) {
            const text = this.pendingTurnSeparator ? '\n\n' + raw : raw;
            this.pendingTurnSeparator = false;
            this.hasEmittedText = true;
            this.callback({ type: 'text_delta', text });
          }
        }
        break;
      }

      case 'content_block_stop': {
        if (this.currentToolId) {
          this.callback({ type: 'tool_end', toolId: this.currentToolId });
          this.currentToolId = null;
        }
        break;
      }
    }
  }
}
