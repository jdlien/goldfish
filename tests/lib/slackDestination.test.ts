import { describe, it, expect } from 'vitest';
import {
  resolveDestination,
  describeDestination,
  CHANNEL_ENV,
  THREAD_ENV,
} from '../../src/lib/slackDestination.js';

/** A Goldfish session replying inside a thread. */
const SESSION = {
  [CHANNEL_ENV]: 'C0TESTCHAN1',
  [THREAD_ENV]: '1789695896.665579',
} as NodeJS.ProcessEnv;

/** A Goldfish session replying at channel top level. */
const SESSION_NO_THREAD = { [CHANNEL_ENV]: 'C0TESTCHAN1' } as NodeJS.ProcessEnv;

describe('resolveDestination', () => {
  it('inherits both channel and thread from the session', () => {
    const r = resolveDestination({}, SESSION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.channel).toBe('C0TESTCHAN1');
    expect(r.value.threadTs).toBe('1789695896.665579');
    expect(r.value.channelInherited).toBe(true);
    expect(r.value.threadInherited).toBe(true);
  });

  it('is the regression case: an upload with no flags lands in the thread', () => {
    // 2026-09-20 — this returned no thread, so an audio clip for Don landed at
    // channel top level while the conversation carried on in a thread.
    const r = resolveDestination({}, SESSION);
    expect(r.ok && r.value.threadTs).toBe('1789695896.665579');
  });

  it('lets an explicit --thread beat the session', () => {
    const r = resolveDestination({ thread: '111.222' }, SESSION);
    expect(r.ok && r.value.threadTs).toBe('111.222');
    expect(r.ok && r.value.threadInherited).toBe(false);
  });

  it('lets --no-thread drop the inherited thread', () => {
    const r = resolveDestination({ noThread: true }, SESSION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.threadTs).toBeUndefined();
    expect(r.value.channel).toBe('C0TESTCHAN1');
  });

  it('rejects a contradictory thread/noThread pair from a programmatic caller', () => {
    // NOTE: unreachable via the CLI. Commander collapses `-t X --no-thread`
    // into a single `thread` key before this runs, so the last flag wins
    // (verified 2026-09-20: `-t 111.222 --no-thread` -> channel top level;
    // `--no-thread -t 111.222` -> thread 111.222). That is standard CLI
    // behaviour and is left alone. This guard exists because `send()` and
    // `upload()` are exported and can be called directly with both set, where
    // silently picking one would hide a caller's bug.
    const r = resolveDestination({ thread: '111.222', noThread: true }, SESSION);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/cannot be used together/);
  });

  it('posts to channel top level when the session has no thread', () => {
    const r = resolveDestination({}, SESSION_NO_THREAD);
    expect(r.ok && r.value.threadTs).toBeUndefined();
    expect(r.ok && r.value.threadInherited).toBe(false);
  });

  it('does not carry a thread ts into a different, explicitly named channel', () => {
    // A thread ts is only meaningful in the channel it came from.
    const r = resolveDestination({ channel: 'C0TESTCHAN2' }, SESSION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.channel).toBe('C0TESTCHAN2');
    expect(r.value.threadTs).toBeUndefined();
    expect(r.value.channelInherited).toBe(false);
  });

  it('still honours an explicit thread in an explicit channel', () => {
    const r = resolveDestination({ channel: 'C0TESTCHAN2', thread: '999.888' }, SESSION);
    expect(r.ok && r.value.channel).toBe('C0TESTCHAN2');
    expect(r.ok && r.value.threadTs).toBe('999.888');
  });

  it('keeps the inherited thread when --channel names the session channel', () => {
    const r = resolveDestination({ channel: 'C0TESTCHAN2' }, {
      [CHANNEL_ENV]: 'C0TESTCHAN2',
      [THREAD_ENV]: '555.444',
    } as NodeJS.ProcessEnv);
    expect(r.ok && r.value.threadTs).toBe('555.444');
  });

  it('errors instead of guessing when there is no channel anywhere', () => {
    const r = resolveDestination({}, {} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/No channel/);
  });

  it('never derives a channel from a thread ts', () => {
    // The old send.ts did `thread.split('.')[0]`, yielding `1789695896`.
    const r = resolveDestination({ thread: '1789695896.665579' }, {} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
  });

  it('treats a blank or whitespace env value as absent', () => {
    const r = resolveDestination({}, {
      [CHANNEL_ENV]: 'C123',
      [THREAD_ENV]: '   ',
    } as NodeJS.ProcessEnv);
    expect(r.ok && r.value.threadTs).toBeUndefined();
  });
});

describe('describeDestination', () => {
  it('marks inherited values so a misfire is visible in the transcript', () => {
    const r = resolveDestination({}, SESSION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(describeDestination(r.value)).toBe(
      'C0TESTCHAN1 (session) — thread 1789695896.665579 (session)',
    );
  });

  it('names channel top level explicitly', () => {
    const r = resolveDestination({ noThread: true }, SESSION);
    expect(r.ok && describeDestination(r.value)).toMatch(/channel top level/);
  });
});
