import { describe, it, expect } from 'vitest';
import { StreamEventParser, type StreamEvent } from '../../src/adapters/StreamEventParser.js';

function collectEvents(lines: string[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const parser = new StreamEventParser((e) => events.push(e));
  for (const line of lines) {
    parser.feed(line + '\n');
  }
  parser.flush();
  return events;
}

describe('StreamEventParser', () => {
  it('parses text_delta events', () => {
    const events = collectEvents([
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }),
    ]);

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
    ]);
  });

  it('parses tool_start and tool_end events', () => {
    const events = collectEvents([
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tool-123', name: 'Bash', input: {} },
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      }),
    ]);

    expect(events).toEqual([
      { type: 'tool_start', toolName: 'Bash', toolId: 'tool-123' },
      { type: 'tool_end', toolId: 'tool-123' },
    ]);
  });

  it('parses result events', () => {
    const events = collectEvents([
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Hello!',
        session_id: 'sess-abc',
        total_cost_usd: 0.05,
        num_turns: 2,
        duration_ms: 1500,
      }),
    ]);

    expect(events).toEqual([
      {
        type: 'result',
        result: 'Hello!',
        sessionId: 'sess-abc',
        costUsd: 0.05,
        numTurns: 2,
        durationMs: 1500,
      },
    ]);
  });

  it('ignores system events', () => {
    const events = collectEvents([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }),
      JSON.stringify({ type: 'system', subtype: 'hook_started', hook_id: 'y' }),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      }),
    ]);

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hi' },
    ]);
  });

  it('ignores assistant snapshot events', () => {
    const events = collectEvents([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'snapshot' }] },
        session_id: 'x',
      }),
    ]);

    expect(events).toEqual([]);
  });

  it('handles partial lines across chunks', () => {
    const events: StreamEvent[] = [];
    const parser = new StreamEventParser((e) => events.push(e));

    const fullLine = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    });

    // Feed in two chunks that split mid-line
    const mid = Math.floor(fullLine.length / 2);
    parser.feed(fullLine.slice(0, mid));
    expect(events).toHaveLength(0); // Not yet complete

    parser.feed(fullLine.slice(mid) + '\n');
    expect(events).toEqual([
      { type: 'text_delta', text: 'partial' },
    ]);
  });

  it('handles empty lines gracefully', () => {
    const events = collectEvents(['', '  ', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    })]);

    expect(events).toEqual([
      { type: 'text_delta', text: 'ok' },
    ]);
  });

  it('skips non-JSON lines without crashing', () => {
    const events = collectEvents([
      'some random output',
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fine' } },
      }),
    ]);

    expect(events).toEqual([
      { type: 'text_delta', text: 'fine' },
    ]);
  });

  it('ignores thinking blocks', () => {
    const events = collectEvents([
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
      }),
    ]);

    // Should not emit thinking as text_delta, and stop should not emit tool_end
    expect(events).toEqual([
      { type: 'text_delta', text: 'answer' },
    ]);
  });

  it('parses tool_result events from user messages', () => {
    const events = collectEvents([
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: 'toolu_abc123',
              type: 'tool_result',
              content: 'hello world',
              is_error: false,
            },
          ],
        },
      }),
    ]);

    expect(events).toEqual([
      {
        type: 'tool_result',
        toolId: 'toolu_abc123',
        output: 'hello world',
        isError: false,
      },
    ]);
  });

  it('handles tool_result content as an array of content blocks', () => {
    const events = collectEvents([
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              tool_use_id: 'toolu_xyz',
              type: 'tool_result',
              content: [
                { type: 'text', text: 'line 1\n' },
                { type: 'text', text: 'line 2' },
              ],
              is_error: false,
            },
          ],
        },
      }),
    ]);

    expect(events).toEqual([
      {
        type: 'tool_result',
        toolId: 'toolu_xyz',
        output: 'line 1\nline 2',
        isError: false,
      },
    ]);
  });

  it('marks tool_result as error when is_error is true', () => {
    const events = collectEvents([
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              tool_use_id: 't1',
              type: 'tool_result',
              content: 'Error: file not found',
              is_error: true,
            },
          ],
        },
      }),
    ]);

    expect(events[0]).toMatchObject({
      type: 'tool_result',
      toolId: 't1',
      isError: true,
    });
  });

  it('emits multiple tool_result events when a user message contains several', () => {
    const events = collectEvents([
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { tool_use_id: 't1', type: 'tool_result', content: 'out1', is_error: false },
            { tool_use_id: 't2', type: 'tool_result', content: 'out2', is_error: false },
          ],
        },
      }),
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ toolId: 't1', output: 'out1' });
    expect(events[1]).toMatchObject({ toolId: 't2', output: 'out2' });
  });

  it('flushes incomplete buffer', () => {
    const events: StreamEvent[] = [];
    const parser = new StreamEventParser((e) => events.push(e));

    const line = JSON.stringify({
      type: 'result',
      result: 'done',
      session_id: 'x',
    });

    // Feed without trailing newline
    parser.feed(line);
    expect(events).toHaveLength(0);

    parser.flush();
    expect(events).toEqual([
      { type: 'result', result: 'done', sessionId: 'x', costUsd: undefined, numTurns: undefined, durationMs: undefined },
    ]);
  });

  it('inserts a blank-line separator between multi-turn text', () => {
    // Simulates: turn 1 text → tool_use → turn 2 text
    // Without the separator, "Checking...Found it." would run together.
    const events = collectEvents([
      // Turn 1 message starts
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'm1', content: [] } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking...' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }),
      // Tool use in turn 1
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      }),
      // Turn 2 message starts
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'm2', content: [] } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it.' } },
      }),
    ]);

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toEqual([
      { type: 'text_delta', text: 'Checking...' },
      { type: 'text_delta', text: '\n\nFound it.' },
    ]);
  });

  it('does not prepend separator on the very first turn', () => {
    const events = collectEvents([
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'm1', content: [] } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      }),
    ]);

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello' },
    ]);
  });

  it('handles interleaved text and tool blocks', () => {
    const events = collectEvents([
      // Text block
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }),
      // Tool block
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      }),
      // More text after tool
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Found it' } },
      }),
    ]);

    expect(events).toEqual([
      { type: 'text_delta', text: 'Let me check' },
      // content_block_stop on text block should NOT emit tool_end (no currentToolId)
      { type: 'tool_start', toolName: 'Read', toolId: 't1' },
      { type: 'tool_end', toolId: 't1' },
      { type: 'text_delta', text: 'Found it' },
    ]);
  });
});
