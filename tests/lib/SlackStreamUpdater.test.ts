import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackStreamUpdater } from '../../src/lib/SlackStreamUpdater.js';
import { ok } from '../../src/domain/services/result.js';

// Mock SlackBoltClient — returns a unique ts for each sendMessage call
function createMockClient() {
  let tsCounter = 0;
  return {
    sendMessage: vi.fn().mockImplementation(() => {
      tsCounter += 1;
      return Promise.resolve(ok(`msg-ts-${tsCounter}`));
    }),
    updateMessage: vi.fn().mockResolvedValue(ok(undefined)),
    deleteMessage: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

describe('SlackStreamUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT post anything on start() — lazy posts on first content', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.updateMessage).not.toHaveBeenCalled();
  });

  it('lazy-posts the first message when text arrives on first tick', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();
    updater.appendText('Hello world');

    // First tick triggers lazy post
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.sendMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: expect.stringContaining('Hello world'),
      threadTs: 'thread-1',
    });
    expect(client.updateMessage).not.toHaveBeenCalled();
  });

  it('lazy-posts the first message when tool status is set via tickNow', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 5000);

    await updater.start();
    updater.setToolStatus('Read');
    await updater.tickNow();

    expect(client.sendMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: expect.stringContaining('📖'),
      threadTs: 'thread-1',
    });
  });

  it('updates in place after the initial lazy post', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();
    updater.appendText('Hello');
    await vi.advanceTimersByTimeAsync(1000); // lazy post

    updater.appendText(' world');
    await vi.advanceTimersByTimeAsync(1000); // update

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.updateMessage).toHaveBeenCalledWith({
      channel: 'C123',
      ts: 'msg-ts-1',
      text: expect.stringContaining('Hello world'),
    });
  });

  it('appends typing cursor during streaming', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();
    updater.appendText('Hello');
    await vi.advanceTimersByTimeAsync(1000);

    const postCall = client.sendMessage.mock.calls[0][0];
    expect(postCall.text).toContain('▍');
  });

  it('shows tool status alongside text', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();
    updater.appendText('Working...');
    updater.setToolStatus('Bash');

    // Text arriving normally clears tool status — test the case where
    // tool was set AFTER text started (atypical but possible)
    // Use direct tick to observe the combined state before the appendText clear
    await vi.advanceTimersByTimeAsync(1000);

    // Note: our current logic clears tool status on appendText, so setting
    // tool status AFTER text means it's visible. Test this path:
    const call = client.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('⚙️');
    expect(call.text).toContain('Running command');
  });

  it('clears tool status automatically when text arrives', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();
    updater.setToolStatus('Bash');
    await vi.advanceTimersByTimeAsync(1000);

    // Verify tool status is shown (lazy posted)
    expect(client.sendMessage.mock.calls[0][0].text).toContain('⚙️');

    // Text arrives → tool status should clear
    updater.appendText('Result is 4');
    await vi.advanceTimersByTimeAsync(1000);

    const lastUpdate = client.updateMessage.mock.calls[client.updateMessage.mock.calls.length - 1][0];
    expect(lastUpdate.text).not.toContain('⚙️');
    expect(lastUpdate.text).toContain('Result is 4');
  });

  it('tickNow() forces an immediate post without waiting for timer', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 5000);

    await updater.start();
    updater.setToolStatus('Read');
    await updater.tickNow();

    // Should have posted immediately, not waiting 5s
    expect(client.sendMessage).toHaveBeenCalled();
    const call = client.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('📖');
  });

  it('finish() updates the streaming message in place with final text (no cursor)', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();
    updater.appendText('streaming content');
    await vi.advanceTimersByTimeAsync(1000); // lazy post 'msg-ts-1'

    await updater.finish('Final answer');

    // Final update goes to the existing message, cursor-free
    const lastUpdate = client.updateMessage.mock.calls[client.updateMessage.mock.calls.length - 1][0];
    expect(lastUpdate.ts).toBe('msg-ts-1');
    expect(lastUpdate.text).toBe('Final answer');
    expect(lastUpdate.text).not.toContain('▍');
  });

  it('finish() posts fresh when nothing was streaming yet (fast response)', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();
    // Response completed before any tick fired — no streaming message exists
    await updater.finish('Quick answer');

    expect(client.updateMessage).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: 'Quick answer',
      threadTs: 'thread-1',
    });
  });

  it('abort() updates the streaming message in place with error text', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();
    updater.appendText('partial');
    await vi.advanceTimersByTimeAsync(1000);

    await updater.abort('❌ Something went wrong');

    const lastUpdate = client.updateMessage.mock.calls[client.updateMessage.mock.calls.length - 1][0];
    expect(lastUpdate.ts).toBe('msg-ts-1');
    expect(lastUpdate.text).toBe('❌ Something went wrong');
  });

  it('finish() awaits in-flight tick before final update (no cursor race)', async () => {
    // Simulate a slow chat.update from a tick that's still in flight
    // when finish() is called. The final update must happen AFTER the
    // tick's update completes, so the cursor-free version wins.
    let resolveUpdate: (() => void) | null = null;
    const updatePromise = new Promise<void>((r) => { resolveUpdate = r; });

    const client = createMockClient();
    let updateCallCount = 0;
    client.updateMessage.mockImplementation(async () => {
      updateCallCount += 1;
      if (updateCallCount === 1) {
        // First update (from tick, contains cursor) — block until released
        await updatePromise;
      }
      return ok(undefined);
    });

    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);
    await updater.start();
    updater.appendText('Hello');
    await vi.advanceTimersByTimeAsync(1000); // lazy post (sendMessage, not update)
    updater.appendText(' world');
    await vi.advanceTimersByTimeAsync(1000); // tick update with cursor — now in flight

    // Start finish() — it should await the pending tick before its own update
    const finishPromise = updater.finish('Hello world');

    // Release the blocked tick
    resolveUpdate!();

    await finishPromise;

    // The LAST updateMessage call should be the cursor-free one from finish()
    const lastCall = client.updateMessage.mock.calls[client.updateMessage.mock.calls.length - 1][0];
    expect(lastCall.text).toBe('Hello world');
    expect(lastCall.text).not.toContain('▍');
  });

  it('does not update if display text has not changed', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();
    updater.appendText('Same');
    await vi.advanceTimersByTimeAsync(1000); // lazy post

    const postCount = client.sendMessage.mock.calls.length;
    const updateCount = client.updateMessage.mock.calls.length;

    // Tick again without new text — no additional calls
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.sendMessage.mock.calls.length).toBe(postCount);
    expect(client.updateMessage.mock.calls.length).toBe(updateCount);
  });

  it('uses default tool label for unknown tools', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', 'thread-1', 1000);

    await updater.start();
    updater.setToolStatus('CustomTool');
    await vi.advanceTimersByTimeAsync(1000);

    const call = client.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('🔧');
    expect(call.text).toContain('CustomTool');
  });

  it('getRawText() returns accumulated text', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', undefined, 1000);

    await updater.start();
    updater.appendText('one ');
    updater.appendText('two ');
    updater.appendText('three');

    expect(updater.getRawText()).toBe('one two three');
  });

  it('getMessageTimestamps() tracks posted messages', async () => {
    const client = createMockClient();
    const updater = new SlackStreamUpdater(client as any, 'C123', undefined, 1000);

    await updater.start();
    expect(updater.getMessageTimestamps()).toEqual([]);

    updater.appendText('hello');
    await vi.advanceTimersByTimeAsync(1000);
    expect(updater.getMessageTimestamps()).toEqual(['msg-ts-1']);
  });
});
