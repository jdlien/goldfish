import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackNativeStreamer } from '../../src/lib/SlackNativeStreamer.js';

// Mock ChatStreamer interface — only the methods we call
function createMockStreamer() {
  return {
    append: vi.fn().mockResolvedValue({ ok: true }),
    stop: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function createMockWebClient(streamer: ReturnType<typeof createMockStreamer>) {
  return {
    chatStream: vi.fn().mockReturnValue(streamer),
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: 'fallback-ts' }),
    },
  };
}

/** Create a Slack platform error matching the shape isSlackPlatformError checks. */
function slackError(code: string): Error & { data: { error: string } } {
  const err = new Error(`An API error occurred: ${code}`) as any;
  err.code = 'slack_webapi_platform_error';
  err.data = { ok: false, error: code };
  return err;
}

describe('SlackNativeStreamer', () => {
  let mockStreamer: ReturnType<typeof createMockStreamer>;
  let mockClient: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    mockStreamer = createMockStreamer();
    mockClient = createMockWebClient(mockStreamer);
  });

  it('creates a ChatStreamer with channel and thread_ts on start()', () => {
    const streamer = new SlackNativeStreamer(
      mockClient as any,
      'C123',
      '1234567890.123456',
    );
    streamer.start();

    expect(mockClient.chatStream).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1234567890.123456',
    });
  });

  it('includes recipient_team_id and recipient_user_id when provided', () => {
    const streamer = new SlackNativeStreamer(
      mockClient as any,
      'C123',
      '1234567890.123456',
      'T456',
      'U789',
    );
    streamer.start();

    expect(mockClient.chatStream).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '1234567890.123456',
      recipient_team_id: 'T456',
      recipient_user_id: 'U789',
    });
  });

  it('omits recipient_team_id and recipient_user_id when not provided', () => {
    const streamer = new SlackNativeStreamer(
      mockClient as any,
      'C123',
      '1234567890.123456',
    );
    streamer.start();

    const args = mockClient.chatStream.mock.calls[0][0];
    expect(args).not.toHaveProperty('recipient_team_id');
    expect(args).not.toHaveProperty('recipient_user_id');
  });

  it('appendText passes raw markdown to streamer.append', async () => {
    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    await streamer.appendText('Hello **world**');

    expect(mockStreamer.append).toHaveBeenCalledWith({
      markdown_text: 'Hello **world**',
    });
  });

  it('appendText preserves markdown tables untouched (no formatForSlack)', async () => {
    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    const table = '| Col1 | Col2 |\n|------|------|\n| A | B |';
    await streamer.appendText(table);

    // Critical: markdown is passed through verbatim. Slack renders it.
    expect(mockStreamer.append).toHaveBeenCalledWith({
      markdown_text: table,
    });
  });

  it('appendText accumulates into getRawText()', async () => {
    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    await streamer.appendText('one ');
    await streamer.appendText('two ');
    await streamer.appendText('three');

    expect(streamer.getRawText()).toBe('one two three');
  });

  it('appendText skips empty strings', async () => {
    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    await streamer.appendText('');

    expect(mockStreamer.append).not.toHaveBeenCalled();
  });

  it('finish() with no final text calls stop() with no args', async () => {
    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    await streamer.finish();

    expect(mockStreamer.stop).toHaveBeenCalledWith();
    expect(streamer.isStopped()).toBe(true);
  });

  it('finish(text) passes final markdown to stop()', async () => {
    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    await streamer.finish('Final answer');

    expect(mockStreamer.stop).toHaveBeenCalledWith({
      markdown_text: 'Final answer',
    });
  });

  it('abort() calls stop() with error text', async () => {
    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    await streamer.abort('❌ Something broke');

    expect(mockStreamer.stop).toHaveBeenCalledWith({
      markdown_text: '❌ Something broke',
    });
    expect(streamer.isStopped()).toBe(true);
  });

  it('double finish() is a no-op (idempotent)', async () => {
    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    await streamer.finish('first');
    await streamer.finish('second');

    expect(mockStreamer.stop).toHaveBeenCalledTimes(1);
  });

  it('appendText after finish() is a no-op', async () => {
    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    await streamer.finish();
    await streamer.appendText('should be ignored');

    expect(mockStreamer.append).not.toHaveBeenCalled();
  });

  it('propagates append errors to the caller', async () => {
    mockStreamer.append.mockRejectedValueOnce(new Error('rate_limited'));

    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    await expect(streamer.appendText('hi')).rejects.toThrow('rate_limited');
  });

  it('abort swallows stop errors (logs but does not throw)', async () => {
    mockStreamer.stop.mockRejectedValueOnce(new Error('network'));

    const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
    streamer.start();

    // Should not throw — we're already in an error state
    await expect(streamer.abort('❌ err')).resolves.toBeUndefined();
    expect(streamer.isStopped()).toBe(true);
  });

  describe('graceful fallback on stream failures', () => {
    it('falls back to chat.postMessage when stop() fails', async () => {
      mockStreamer.stop.mockRejectedValueOnce(new Error('stream broken'));

      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'thread-1');
      streamer.start();

      await streamer.abort('❌ Error: upstream died');

      // Fallback should post via chat.postMessage with the error text
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: '❌ Error: upstream died',
        thread_ts: 'thread-1',
      });
    });

    it('falls back to chat.postMessage when streamer was never created', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'thread-1');
      // Do NOT call start() — streamer is null

      await streamer.abort('❌ Error: never started');

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: '❌ Error: never started',
        thread_ts: 'thread-1',
      });
    });

    it('skips chat.postMessage fallback when stop() succeeds', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.abort('done');

      expect(mockStreamer.stop).toHaveBeenCalled();
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it('silently logs when the fallback postMessage also fails', async () => {
      mockStreamer.stop.mockRejectedValueOnce(new Error('stream broken'));
      mockClient.chat.postMessage.mockRejectedValueOnce(new Error('all broken'));

      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      // Should not throw even though everything failed
      await expect(streamer.abort('err')).resolves.toBeUndefined();
      expect(streamer.isStopped()).toBe(true);
    });
  });

  describe('tool status (task_update chunks)', () => {
    it('startTool sends a task_update chunk with in_progress status', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('tool-1', 'Read');

      expect(mockStreamer.append).toHaveBeenCalledWith({
        chunks: [
          {
            type: 'task_update',
            id: 'tool-1',
            title: 'Reading file',
            status: 'in_progress',
          },
        ],
      });
    });

    it('startTool uses human-readable labels for known tools', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Bash');
      await streamer.startTool('t2', 'Grep');
      await streamer.startTool('t3', 'WebFetch');

      // Filter to in_progress chunks only (each startTool after the first
      // also emits a complete for the prior tool)
      const inProgressTitles = mockStreamer.append.mock.calls
        .map((c: any) => c[0].chunks[0])
        .filter((chunk: any) => chunk.status === 'in_progress')
        .map((chunk: any) => chunk.title);
      expect(inProgressTitles).toEqual(['Running command', 'Searching code', 'Fetching page']);
    });

    it('startTool falls back to "Using <name>" for unknown tools', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'CustomTool');

      const chunk = mockStreamer.append.mock.calls[0][0].chunks[0];
      expect(chunk.title).toBe('Using CustomTool');
    });

    it('appendText auto-completes pending tools before sending text', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Read');
      mockStreamer.append.mockClear();

      await streamer.appendText('I found the answer.');

      // First append should be the complete chunk, second should be the text
      expect(mockStreamer.append).toHaveBeenCalledTimes(2);
      expect(mockStreamer.append).toHaveBeenNthCalledWith(1, {
        chunks: [
          {
            type: 'task_update',
            id: 't1',
            title: 'Reading file',
            status: 'complete',
          },
        ],
      });
      expect(mockStreamer.append).toHaveBeenNthCalledWith(2, {
        markdown_text: 'I found the answer.',
      });
    });

    it('appendText does not re-complete already-completed tools', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Read');
      await streamer.appendText('First text'); // completes t1
      mockStreamer.append.mockClear();

      await streamer.appendText('More text');

      // Only one call, for the text — no extra complete chunks
      expect(mockStreamer.append).toHaveBeenCalledTimes(1);
      expect(mockStreamer.append).toHaveBeenCalledWith({
        markdown_text: 'More text',
      });
    });

    it('finish() completes any pending tools before stopping', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Read');
      mockStreamer.append.mockClear();

      await streamer.finish();

      // Completion chunk sent via append before stop()
      expect(mockStreamer.append).toHaveBeenCalledWith({
        chunks: [
          {
            type: 'task_update',
            id: 't1',
            title: 'Reading file',
            status: 'complete',
          },
        ],
      });
      expect(mockStreamer.stop).toHaveBeenCalled();
    });

    it('text arriving after a tool auto-completes it', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Read');
      await streamer.startTool('t2', 'Bash'); // auto-completes t1
      mockStreamer.append.mockClear();

      await streamer.appendText('Done.');

      // Only t2 is still pending; appendText completes it then sends text
      expect(mockStreamer.append).toHaveBeenCalledTimes(2);
      expect(mockStreamer.append.mock.calls[0][0].chunks[0]).toMatchObject({
        id: 't2',
        status: 'complete',
      });
      expect(mockStreamer.append.mock.calls[1][0]).toEqual({
        markdown_text: 'Done.',
      });
    });

    it('startTool swallows errors instead of crashing the stream', async () => {
      mockStreamer.append.mockRejectedValueOnce(new Error('slack rejected'));

      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      // Should not throw — tool status is non-critical
      await expect(streamer.startTool('t1', 'Read')).resolves.toBeUndefined();
    });

    it('completeToolWithOutput sends a task_update with status complete and output', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Bash');
      mockStreamer.append.mockClear();

      await streamer.completeToolWithOutput('t1', 'hello world', false);

      expect(mockStreamer.append).toHaveBeenCalledWith({
        chunks: [
          {
            type: 'task_update',
            id: 't1',
            title: 'Running command',
            status: 'complete',
            output: 'hello world',
          },
        ],
      });
    });

    it('completeToolWithOutput sets status to error when isError is true', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Bash');
      mockStreamer.append.mockClear();

      await streamer.completeToolWithOutput('t1', 'command not found', true);

      const call = mockStreamer.append.mock.calls[0][0].chunks[0];
      expect(call.status).toBe('error');
      expect(call.output).toBe('command not found');
    });

    it('completeToolWithOutput truncates very long output', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Bash');
      mockStreamer.append.mockClear();

      const longOutput = 'x'.repeat(5000);
      await streamer.completeToolWithOutput('t1', longOutput, false);

      const chunk = mockStreamer.append.mock.calls[0][0].chunks[0];
      expect(chunk.output.length).toBeLessThan(longOutput.length);
      expect(chunk.output).toContain('more chars truncated');
    });

    it('completeToolWithOutput includes sources when provided', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'WebFetch');
      mockStreamer.append.mockClear();

      const sources = [
        { type: 'url' as const, url: 'https://example.com', text: 'https://example.com' },
      ];
      await streamer.completeToolWithOutput('t1', 'page contents', false, sources);

      const chunk = mockStreamer.append.mock.calls[0][0].chunks[0];
      expect(chunk.sources).toEqual(sources);
    });

    it('completeToolWithOutput omits sources field when empty or undefined', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Bash');
      mockStreamer.append.mockClear();

      await streamer.completeToolWithOutput('t1', 'output', false);

      const chunk = mockStreamer.append.mock.calls[0][0].chunks[0];
      expect(chunk).not.toHaveProperty('sources');
    });

    it('completeToolWithOutput omits output field when empty', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Bash');
      mockStreamer.append.mockClear();

      await streamer.completeToolWithOutput('t1', '', false);

      const chunk = mockStreamer.append.mock.calls[0][0].chunks[0];
      expect(chunk).not.toHaveProperty('output');
      expect(chunk.status).toBe('complete');
    });

    it('completeToolWithOutput removes the tool from pendingTools', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Read');
      await streamer.completeToolWithOutput('t1', 'file contents', false);
      mockStreamer.append.mockClear();

      // finish() should NOT re-send a complete for t1
      await streamer.finish();

      // No task_update chunks from finish — only the stop() call
      const appendCalls = mockStreamer.append.mock.calls;
      expect(appendCalls.length).toBe(0);
    });

    it('sequential startTool calls complete the previous tool automatically', async () => {
      // Regression: 3 sequential Bash calls all stuck in_progress because
      // completion only ran on text or finish, never on the next tool.
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.startTool('t1', 'Bash');
      await streamer.startTool('t2', 'Bash');
      await streamer.startTool('t3', 'Bash');

      // Call sequence:
      // 1. in_progress t1
      // 2. complete t1 (from t2's startTool)
      // 3. in_progress t2
      // 4. complete t2 (from t3's startTool)
      // 5. in_progress t3
      expect(mockStreamer.append).toHaveBeenCalledTimes(5);

      const calls = mockStreamer.append.mock.calls.map((c: any) => c[0].chunks[0]);
      expect(calls[0]).toMatchObject({ id: 't1', status: 'in_progress' });
      expect(calls[1]).toMatchObject({ id: 't1', status: 'complete' });
      expect(calls[2]).toMatchObject({ id: 't2', status: 'in_progress' });
      expect(calls[3]).toMatchObject({ id: 't2', status: 'complete' });
      expect(calls[4]).toMatchObject({ id: 't3', status: 'in_progress' });

      // Then finish should complete the last one
      mockStreamer.append.mockClear();
      await streamer.finish();

      const completeCall = mockStreamer.append.mock.calls[0][0].chunks[0];
      expect(completeCall).toMatchObject({ id: 't3', status: 'complete' });
    });

    it('startTool is a no-op after the stream is stopped', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();
      await streamer.finish();
      mockStreamer.append.mockClear();

      await streamer.startTool('late', 'Read');

      expect(mockStreamer.append).not.toHaveBeenCalled();
    });
  });

  // =================================================================
  // BUG: No way to know what text was lost after a streaming failure.
  //
  // When an append fails (stream auto-finalized, network error, etc),
  // rawText has the full content but there's no way to know which
  // portion was actually delivered to Slack vs lost. The caller needs
  // getUnsentText() to post the remainder as a follow-up message.
  // =================================================================

  describe('unsent text tracking (getUnsentText) — RED: requires new feature', () => {
    it('exposes a getUnsentText() method', () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      expect(typeof streamer.getUnsentText).toBe('function');
    });

    it('returns empty string when all text was successfully sent', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.appendText('hello ');
      await streamer.appendText('world');

      expect(streamer.getUnsentText()).toBe('');
    });

    it('returns the failed chunk when append throws', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.appendText('sent ok ');

      mockStreamer.append.mockRejectedValueOnce(new Error('rate_limited'));
      await expect(streamer.appendText('lost chunk')).rejects.toThrow('rate_limited');

      // rawText has everything, but only the first chunk made it to Slack
      expect(streamer.getRawText()).toBe('sent ok lost chunk');
      expect(streamer.getUnsentText()).toBe('lost chunk');
    });

    it('tracks confirmed bytes correctly across a successful rollover', async () => {
      const streamer2 = createMockStreamer();
      mockClient.chatStream
        .mockReturnValueOnce(mockStreamer)
        .mockReturnValueOnce(streamer2);

      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.appendText('aaa');

      // Stream dies, triggers rollover + retry on new stream
      mockStreamer.append.mockRejectedValueOnce(
        slackError('message_not_in_streaming_state'),
      );
      mockStreamer.stop.mockRejectedValueOnce(
        slackError('message_not_in_streaming_state'),
      );

      await streamer.appendText('bbb');

      // Both chunks confirmed (just on different streams)
      expect(streamer.getRawText()).toBe('aaabbb');
      expect(streamer.getUnsentText()).toBe('');
    });

    it('reports unsent text when rollover retry also fails', async () => {
      const streamer2 = createMockStreamer();
      mockClient.chatStream
        .mockReturnValueOnce(mockStreamer)
        .mockReturnValueOnce(streamer2);

      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.appendText('sent ok ');

      mockStreamer.append.mockRejectedValueOnce(
        slackError('message_not_in_streaming_state'),
      );
      mockStreamer.stop.mockRejectedValueOnce(
        slackError('message_not_in_streaming_state'),
      );
      streamer2.append.mockRejectedValueOnce(new Error('also broken'));

      await expect(streamer.appendText('lost text')).rejects.toThrow('also broken');

      expect(streamer.getRawText()).toBe('sent ok lost text');
      expect(streamer.getUnsentText()).toBe('lost text');
    });

    it('handles multiple successes then a late failure', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.appendText('p1. ');
      await streamer.appendText('p2. ');
      await streamer.appendText('p3. ');

      mockStreamer.append.mockRejectedValueOnce(new Error('connection reset'));
      await expect(streamer.appendText('p4.')).rejects.toThrow();

      expect(streamer.getRawText()).toBe('p1. p2. p3. p4.');
      expect(streamer.getUnsentText()).toBe('p4.');
    });

    it('unsent text survives abort()', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.appendText('sent ');

      mockStreamer.append.mockRejectedValueOnce(new Error('dead'));
      await expect(streamer.appendText('not sent')).rejects.toThrow('dead');

      await streamer.abort('⚠️ interrupted');

      // Caller can still retrieve unsent text after abort
      expect(streamer.getUnsentText()).toBe('not sent');
    });

    it('proactive rollover at threshold preserves confirmed byte count', async () => {
      const streamer2 = createMockStreamer();
      mockClient.chatStream
        .mockReturnValueOnce(mockStreamer)
        .mockReturnValueOnce(streamer2);

      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      const bigChunk = 'x'.repeat(7900);
      await streamer.appendText(bigChunk);

      // Triggers proactive rollover (7900 + 200 > 8000)
      const overflowChunk = 'y'.repeat(200);
      await streamer.appendText(overflowChunk);

      expect(streamer.getRawText()).toBe(bigChunk + overflowChunk);
      expect(streamer.getUnsentText()).toBe('');
    });
  });

  // =================================================================
  // Existing behavior tests for streaming error recovery that should
  // already pass on the current code (from commit 16de4ba).
  // =================================================================

  describe('message_not_in_streaming_state — existing recovery', () => {
    it('rolls over to a new stream on append when stream is auto-finalized', async () => {
      const streamer2 = createMockStreamer();
      mockClient.chatStream
        .mockReturnValueOnce(mockStreamer)
        .mockReturnValueOnce(streamer2);

      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.appendText('first chunk ');

      mockStreamer.append.mockRejectedValueOnce(
        slackError('message_not_in_streaming_state'),
      );
      mockStreamer.stop.mockRejectedValueOnce(
        slackError('message_not_in_streaming_state'),
      );

      await streamer.appendText('second chunk');

      expect(mockClient.chatStream).toHaveBeenCalledTimes(2);
      expect(streamer2.append).toHaveBeenCalledWith({
        markdown_text: 'second chunk',
      });
    });

    it('finish() swallows message_not_in_streaming_state and does not throw', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.appendText('some text');

      mockStreamer.stop.mockRejectedValueOnce(
        slackError('message_not_in_streaming_state'),
      );

      await expect(streamer.finish()).resolves.toBeUndefined();
      expect(streamer.isStopped()).toBe(true);
    });

    it('finish() posts final markdown via postMessage when stream is auto-finalized', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'thread-1');
      streamer.start();

      mockStreamer.stop.mockRejectedValueOnce(
        slackError('message_not_in_streaming_state'),
      );

      await streamer.finish('Final paragraph');

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: 'Final paragraph',
        thread_ts: 'thread-1',
      });
    });

    it('finish() without finalMarkdown does NOT post when stream is auto-finalized', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.appendText('already streamed');

      mockStreamer.stop.mockRejectedValueOnce(
        slackError('message_not_in_streaming_state'),
      );

      await streamer.finish();

      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it('finish() re-throws non-streaming errors', async () => {
      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      mockStreamer.stop.mockRejectedValueOnce(new Error('network timeout'));

      await expect(streamer.finish()).rejects.toThrow('network timeout');
    });
  });

  describe('msg_too_long — existing recovery', () => {
    it('rolls over and retries on msg_too_long during appendText', async () => {
      const streamer2 = createMockStreamer();
      mockClient.chatStream
        .mockReturnValueOnce(mockStreamer)
        .mockReturnValueOnce(streamer2);

      const streamer = new SlackNativeStreamer(mockClient as any, 'C123', 'T1');
      streamer.start();

      await streamer.appendText('first chunk ');

      mockStreamer.append.mockRejectedValueOnce(slackError('msg_too_long'));

      await streamer.appendText('overflowed chunk');

      expect(mockClient.chatStream).toHaveBeenCalledTimes(2);
      expect(streamer2.append).toHaveBeenCalledWith({
        markdown_text: 'overflowed chunk',
      });
    });
  });
});
