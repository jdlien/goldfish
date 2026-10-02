import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  startOptions: [] as unknown[],
  resumeCalls: [] as Array<{ id: string; options: unknown }>,
  inputs: [] as unknown[],
  runMode: 'success' as 'success' | 'throw' | 'hang' | 'no-id',
  streamMode: 'success' as 'success' | 'error' | 'turn-failed' | 'no-id',
}));

vi.mock('@openai/codex-sdk', () => {
  class FakeThread {
    id: string | null;

    constructor() {
      this.id = state.runMode === 'no-id' || state.streamMode === 'no-id'
        ? null
        : 'codex-thread-123';
    }

    async run(input: unknown, options: { signal: AbortSignal }) {
      state.inputs.push(input);
      if (state.runMode === 'throw') throw new Error('SDK exploded');
      if (state.runMode === 'hang') {
        return new Promise((_, reject) => {
          const fail = () => reject(options.signal.reason ?? new Error('aborted'));
          if (options.signal.aborted) fail();
          else options.signal.addEventListener('abort', fail, { once: true });
        });
      }
      return {
        items: [],
        finalResponse: 'Hello from Codex',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 5,
          reasoning_output_tokens: 3,
        },
      };
    }

    async runStreamed(input: unknown) {
      state.inputs.push(input);
      const mode = state.streamMode;
      async function* events() {
        if (mode === 'error') {
          yield { type: 'error', message: 'stream exploded' };
          return;
        }
        if (mode === 'turn-failed') {
          yield { type: 'turn.failed', error: { message: 'turn exploded' } };
          return;
        }
        if (mode !== 'no-id') yield { type: 'thread.started', thread_id: 'codex-thread-123' };
        yield { type: 'item.started', item: { id: 'tool-1', type: 'command_execution', command: 'pwd', aggregated_output: '', status: 'in_progress' } };
        yield { type: 'item.completed', item: { id: 'tool-1', type: 'command_execution', command: 'pwd', aggregated_output: '/workspace', exit_code: 0, status: 'completed' } };
        yield { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Done' } };
        yield { type: 'turn.completed', usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 } };
      }
      return { events: events() };
    }
  }

  return {
    Codex: class {
      constructor(options: unknown) { state.constructorOptions.push(options); }
      startThread(options: unknown) {
        state.startOptions.push(options);
        return new FakeThread();
      }
      resumeThread(id: string, options: unknown) {
        state.resumeCalls.push({ id, options });
        return new FakeThread();
      }
    },
  };
});

import { CodexRunner } from '../../src/adapters/CodexRunner.js';

describe('CodexRunner', () => {
  beforeEach(() => {
    state.constructorOptions.length = 0;
    state.startOptions.length = 0;
    state.resumeCalls.length = 0;
    state.inputs.length = 0;
    state.runMode = 'success';
    state.streamMode = 'success';
  });

  it('uses the SDK-pinned CLI by default and only overrides it explicitly', async () => {
    await new CodexRunner().run({ prompt: 'default', timeoutMs: 1_000 });
    expect(state.constructorOptions[0]).not.toHaveProperty('codexPathOverride');

    await new CodexRunner({ codexPath: '/custom/codex' }).run({ prompt: 'custom', timeoutMs: 1_000 });
    expect(state.constructorOptions[1]).toMatchObject({ codexPathOverride: '/custom/codex' });
  });

  it('normalizes a completed SDK turn and applies unattended policy options', async () => {
    const result = await new CodexRunner({
      defaultNetworkAccess: true,
      defaultWebSearchMode: 'live',
      defaultAdditionalDirectories: ['/shared'],
    }).run({ prompt: 'hello', model: 'gpt-test', effort: 'high', timeoutMs: 1_000 });

    expect(result.ok && result.value).toMatchObject({
      backend: 'codex',
      result: 'Hello from Codex',
      sessionId: 'codex-thread-123',
      usage: { inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 3 },
    });
    expect(state.startOptions[0]).toMatchObject({
      model: 'gpt-test',
      modelReasoningEffort: 'high',
      sandboxMode: 'workspace-write',
      networkAccessEnabled: true,
      webSearchMode: 'live',
      approvalPolicy: 'never',
      additionalDirectories: ['/shared'],
    });
    expect(state.inputs[0]).toEqual(expect.stringContaining('<goldfish-delivery-instructions>'));
  });

  it('resumes the exact thread without repeating first-turn delivery instructions', async () => {
    await new CodexRunner().run({
      prompt: 'continue',
      resumeSessionId: 'exact-thread-id',
      timeoutMs: 1_000,
    });
    expect(state.resumeCalls[0]).toMatchObject({ id: 'exact-thread-id' });
    expect(state.inputs[0]).toBe('continue');
  });

  it('passes local images structurally and keeps synthesis isolated', async () => {
    await new CodexRunner().run({
      prompt: 'inspect',
      imagePaths: ['/tmp/picture.png'],
      profile: 'synthesis',
      timeoutMs: 1_000,
    });
    expect(state.inputs[0]).toEqual([
      { type: 'text', text: 'inspect' },
      { type: 'local_image', path: '/tmp/picture.png' },
    ]);
    expect(state.startOptions[0]).toMatchObject({
      sandboxMode: 'read-only',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      additionalDirectories: [],
    });
  });

  it('distinguishes its timeout from an external abort', async () => {
    state.runMode = 'hang';
    const timedOut = await new CodexRunner().run({ prompt: 'wait', timeoutMs: 5 });
    expect(timedOut.ok).toBe(false);
    if (timedOut.ok) throw new Error('expected timeout');
    expect(timedOut.error.code).toBe('CODEX_TIMEOUT');

    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    const aborted = await new CodexRunner().run({ prompt: 'wait', timeoutMs: 1_000, signal: controller.signal });
    expect(aborted.ok).toBe(false);
    if (aborted.ok) throw new Error('expected abort failure');
    expect(aborted.error.code).toBe('CODEX_SPAWN_FAILED');
  });

  it('rejects a non-streaming response without a thread ID', async () => {
    state.runMode = 'no-id';
    const result = await new CodexRunner().run({ prompt: 'hello', timeoutMs: 1_000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected protocol failure');
    expect(result.error.code).toBe('CODEX_PROTOCOL_ERROR');
  });

  it('maps tool events and a terminal result in streaming mode', async () => {
    const events = [];
    for await (const event of new CodexRunner().runStream({ prompt: 'work', timeoutMs: 1_000 })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(['tool_start', 'tool_result', 'tool_end', 'text_delta', 'result']);
    expect(events.at(-1)).toMatchObject({ type: 'result', result: 'Done', sessionId: 'codex-thread-123' });
  });

  it.each(['error', 'turn-failed'] as const)('surfaces %s stream failures', async (mode) => {
    state.streamMode = mode;
    const consume = async () => {
      for await (const _event of new CodexRunner().runStream({ prompt: 'work', timeoutMs: 1_000 })) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow('Codex run failed');
  });

  it('rejects a streamed response without a thread ID', async () => {
    state.streamMode = 'no-id';
    const consume = async () => {
      for await (const _event of new CodexRunner().runStream({ prompt: 'work', timeoutMs: 1_000 })) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow('without a thread ID');
  });
});
