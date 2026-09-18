import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const { execFile } = await import('child_process');
const { AudioTranscriber, deadlineFor, probeDurationMs } = await import(
  '../../src/adapters/AudioTranscriber.js'
);
const { MW_BIN_PATH } = await import('../../src/config.js');

const execFileMock = vi.mocked(execFile);

/** A child process that never exits unless told to. */
class FakeChild extends EventEmitter {
  killed = false;
  kill(_signal?: string) {
    this.killed = true;
    return true;
  }
}

/** Make execFile produce a child that closes with `code` on the next tick. */
function childExitingWith(code: number | null, signal?: string) {
  return () => {
    const child = new FakeChild();
    setImmediate(() => child.emit('close', code, signal));
    return child as never;
  };
}

let tempDir: string;
let audioPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'goldfish-mw-'));
  audioPath = join(tempDir, 'note.m4a');
  await writeFile(audioPath, 'fake audio');
  execFileMock.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(tempDir, { recursive: true, force: true });
});

describe('deadlineFor', () => {
  it('floors at 60s and scales with duration', () => {
    expect(deadlineFor(undefined)).toBe(60_000);
    expect(deadlineFor(19_101)).toBe(60_000);
    // A ten-minute note on a cold app needs more than the floor.
    expect(deadlineFor(10 * 60_000)).toBe(180_000);
  });

  // Node throws ERR_OUT_OF_RANGE for a fractional execFile timeout, from
  // inside the promise executor — i.e. as a rejection, not an err() Result.
  // Slack's duration_ms is arbitrary, so most notes over two minutes hit it.
  // The original tests used only 19_101 (below the floor) and 600_000
  // (divisible by 4), so none of them could see it.
  it('is ALWAYS an integer, for every arbitrary duration', () => {
    for (const ms of [150_001, 150_002, 150_003, 152_808, 121_001, 999_999]) {
      expect(Number.isInteger(deadlineFor(ms))).toBe(true);
    }
  });
});

describe('AudioTranscriber.transcribe', () => {
  it('returns the transcript on success', async () => {
    execFileMock.mockImplementation(((...args: unknown[]) => {
      const child = new FakeChild();
      // Write the sidecar the way mw's `-o` would, and only THEN close —
      // firing close on a timer alongside a fire-and-forget write is a race
      // that passes on an idle machine and flakes under load.
      void writeFile(`${audioPath}.txt`, 'Sample transcribed speech.\n').then(() =>
        child.emit('close', 0, undefined),
      );
      return child as never;
    }) as never);

    const result = await new AudioTranscriber().transcribe(audioPath, 19_101);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('Sample transcribed speech.');
  });

  it('invokes mw by ABSOLUTE path with every default pinned', async () => {
    await writeFile(`${audioPath}.txt`, 'hi');
    execFileMock.mockImplementation(childExitingWith(0) as never);

    await new AudioTranscriber().transcribe(audioPath, 1000);

    const [bin, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(bin.startsWith('/')).toBe(true);
    expect(bin).toBe(MW_BIN_PATH);
    // Unpinned, these silently follow MacWhisper's GUI selection.
    expect(args).toContain('--model');
    expect(args).toContain('--no-speakers');
    expect(args).toContain('--no-timestamps');
    expect(args).toContain('--style');
    expect(args).toContain('--overwrite');
    expect(args).toContain('-o');
    expect(args).toContain(`${audioPath}.txt`);
  });

  it('reports AUDIO_NO_SPEECH for a silent recording', async () => {
    await writeFile(`${audioPath}.txt`, '   \n  ');
    execFileMock.mockImplementation(childExitingWith(0) as never);

    const result = await new AudioTranscriber().transcribe(audioPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUDIO_NO_SPEECH');
  });

  it('reports failure on non-zero exit', async () => {
    execFileMock.mockImplementation(childExitingWith(1) as never);
    const result = await new AudioTranscriber().transcribe(audioPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUDIO_TRANSCRIPTION_FAILED');
  });

  it('reports failure when exit is 0 but no transcript was written', async () => {
    execFileMock.mockImplementation(childExitingWith(0) as never);
    const result = await new AudioTranscriber().transcribe(audioPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUDIO_TRANSCRIPTION_FAILED');
  });

  it('reports failure when the process errors', async () => {
    execFileMock.mockImplementation(((...args: unknown[]) => {
      const child = new FakeChild();
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child as never;
    }) as never);

    const result = await new AudioTranscriber().transcribe(audioPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUDIO_TRANSCRIPTION_FAILED');
  });

  // The one that matters most. execFile's `timeout` is a SIGTERM, not a
  // deadline: a child blocked on a MacWhisper modal never dies, never emits
  // 'close', and a promisified execFile never settles — which would leave the
  // caller's per-session lock held forever, killing the thread with no error
  // anyone can see.
  it('SETTLES even when the child never exits', async () => {
    vi.useFakeTimers();
    let child!: FakeChild;
    execFileMock.mockImplementation((() => {
      child = new FakeChild();
      return child as never; // never emits anything, ever
    }) as never);

    const promise = new AudioTranscriber().transcribe(audioPath, 1000);
    await vi.advanceTimersByTimeAsync(60_000 + 5_000 + 10);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUDIO_TRANSCRIPTION_FAILED');
    expect(child.killed).toBe(true);
  });

  it('kills with SIGKILL, not SIGTERM', async () => {
    await writeFile(`${audioPath}.txt`, 'hi');
    execFileMock.mockImplementation(childExitingWith(0) as never);
    await new AudioTranscriber().transcribe(audioPath);
    const opts = execFileMock.mock.calls[0][2] as { killSignal?: string };
    expect(opts.killSignal).toBe('SIGKILL');
  });

  // The mock can't reject a bad timeout the way the real API does, so assert
  // the property the real API validates.
  it('passes an integer timeout for an arbitrary duration', async () => {
    await writeFile(`${audioPath}.txt`, 'hi');
    execFileMock.mockImplementation(childExitingWith(0) as never);
    await new AudioTranscriber().transcribe(audioPath, 150_001);
    const opts = execFileMock.mock.calls[0][2] as { timeout?: number };
    expect(Number.isInteger(opts.timeout)).toBe(true);
  });

  // execFile validates its arguments and can throw BEFORE spawning. Inside a
  // promise executor that is a rejection, which would break "never throws" and
  // take the caller's whole message down with it.
  it('does not throw when execFile throws synchronously', async () => {
    execFileMock.mockImplementation((() => {
      throw new TypeError('The value of "timeout" is out of range.');
    }) as never);

    const result = await new AudioTranscriber().transcribe(audioPath, 150_001);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUDIO_TRANSCRIPTION_FAILED');
  });
});

describe('probeDurationMs', () => {
  it('parses afinfo output', async () => {
    execFileMock.mockImplementation(((_b: unknown, _a: unknown, _o: unknown, cb: Function) => {
      cb(null, 'estimated duration: 19.082000 sec\n', '');
      return new FakeChild() as never;
    }) as never);

    expect(await probeDurationMs(audioPath)).toBe(19082);
  });

  it('returns undefined when afinfo fails, so the caller fails closed', async () => {
    execFileMock.mockImplementation(((_b: unknown, _a: unknown, _o: unknown, cb: Function) => {
      cb(new Error('boom'), '', '');
      return new FakeChild() as never;
    }) as never);

    expect(await probeDurationMs(audioPath)).toBeUndefined();
  });

  it('returns undefined for a missing file', async () => {
    expect(await probeDurationMs(join(tempDir, 'nope.m4a'))).toBeUndefined();
  });
});
