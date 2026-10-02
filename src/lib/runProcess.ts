import { execFile } from 'child_process';

/** Grace period after the deadline before we stop waiting on the child at all. */
const HARD_KILL_GRACE_MS = 5_000;

export interface RunOutcome {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  /** ocrmypdf/tesseract report per-page confidence here, not on stdout. */
  stderr: string;
  error?: unknown;
}

/**
 * Run a child process that is GUARANTEED to settle.
 *
 * `execFile`'s own `timeout` is not a deadline — it is a signal. If the child is
 * blocked in an uninterruptible wait (mw sitting on a MacWhisper modal; a
 * subprocess stuck on a corrupt PDF) it will not die, no 'close' event fires,
 * and a promisified execFile never settles at all.
 *
 * That matters more than it sounds: callers run inside the per-session lock,
 * whose `.finally()` release is downstream of the await. A promise that never
 * settles leaves the lock held forever — every later message in that thread
 * posts "Queued..." and hangs, with no error anyone can see and no recovery
 * short of restarting the daemon.
 *
 * So: SIGKILL rather than SIGTERM, a try/catch around the spawn itself (execFile
 * validates arguments and can throw BEFORE spawning — a fractional timeout, a
 * misconfigured binary path — which inside a promise executor becomes a
 * rejection), and an independent timer that resolves on its own even if the
 * child outlives everything.
 *
 * Extracted from AudioTranscriber once a second adapter needed it. Never throws.
 */
export function runWithDeadline(
  bin: string,
  args: string[],
  deadlineMs: number,
  maxBuffer = 64 * 1024 * 1024,
): Promise<RunOutcome> {
  // Guard here as well as at the call sites: Node rejects a non-integer
  // timeout with ERR_OUT_OF_RANGE, thrown synchronously.
  const deadline = Math.max(1_000, Math.ceil(deadlineMs));

  return new Promise((resolve) => {
    let settled = false;
    let hardTimer: NodeJS.Timeout | undefined;
    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();

    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      resolve(outcome);
    };

    let child;
    try {
      child = execFile(
        bin,
        args,
        { timeout: deadline, killSignal: 'SIGKILL', maxBuffer },
        (_error, out, errOut) => {
          stdout = out ?? '';
          stderr = errOut ?? '';
        },
      );
    } catch (error) {
      finish({ code: null, timedOut: false, stdout: '', stderr: '', error });
      return;
    }

    hardTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone, or unkillable. Either way we stop waiting.
      }
      finish({ code: null, timedOut: true, stdout, stderr });
    }, deadline + HARD_KILL_GRACE_MS);

    child.on('error', (error) =>
      finish({ code: null, timedOut: false, stdout, stderr, error }),
    );
    child.on('close', (code, signal) =>
      finish({
        code,
        stdout,
        stderr,
        // Judge by the clock, not the signal. A SIGKILL can also come from
        // maxBuffer overflow or someone's `kill -9`; logging those as
        // "exceeded deadline" sends the next reader down the wrong path.
        timedOut:
          code === null &&
          signal === 'SIGKILL' &&
          Date.now() - startedAt >= deadline,
      }),
    );
  });
}
