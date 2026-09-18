import { execFile } from 'child_process';
import { readFile, stat } from 'fs/promises';
import {
  type Result,
  ok,
  err,
  createError,
  ErrorCodes,
} from '../domain/services/result.js';
import { createChildLogger } from '../lib/logger.js';
import {
  MW_BIN_PATH,
  MW_MODEL,
  TRANSCRIBE_LANGUAGE,
} from '../config.js';

const logger = createChildLogger('AudioTranscriber');

/** Duration probe binary. On the daemon's PATH, unlike `mw`. ~24ms per call. */
const AFINFO_BIN = '/usr/bin/afinfo';

/** Grace period after the deadline before we stop waiting on the child at all. */
const HARD_KILL_GRACE_MS = 5_000;

/** Marks a failure as "the transcriber wedged", not "this file was bad". */
export const DEADLINE_ERROR_PREFIX = '[deadline]';

/**
 * Transcribes audio to text using the MacWhisper CLI.
 *
 * Two things about `mw` shape this whole class:
 *
 * 1. It writes the transcript to BOTH stdout and stderr (stderr additionally
 *    carries a `Transcribing <name>...` progress line). Parsing either stream is
 *    a trap, so we use `-o <file>` and read the file back.
 *
 * 2. Every flag it accepts defaults to whatever MacWhisper.app's GUI currently
 *    has selected — model, diarization, timestamps. We pin all of them. See
 *    MW_MODEL in config.ts for what goes wrong otherwise.
 *
 * `mw` drives the GUI app, so this only works because the Goldfish daemon is a
 * LaunchAgent in the user's Aqua session (`launchctl print gui/501/...`).
 */
export class AudioTranscriber {
  constructor(
    private binPath: string = MW_BIN_PATH,
    private model: string = MW_MODEL,
    private language: string = TRANSCRIBE_LANGUAGE,
  ) {}

  /**
   * Transcribe `audioPath`, writing a `.txt` sidecar next to it.
   *
   * Returns AUDIO_NO_SPEECH when the run succeeded but produced no words — a
   * silent or pocket recording. That is deliberately distinct from
   * AUDIO_TRANSCRIPTION_FAILED ("the machine broke"), because the sender's next
   * action differs: check the mic, versus send it again.
   *
   * Never throws.
   */
  async transcribe(
    audioPath: string,
    durationMs?: number,
  ): Promise<Result<string>> {
    const transcriptPath = `${audioPath}.txt`;
    const deadlineMs = deadlineFor(durationMs);

    const args = [
      'transcribe',
      '--model', this.model,
      '--language', this.language,
      '--format', 'txt',
      // Also collapses the pause line-breaks the default style emits, which is
      // what makes the transcript quotable rather than a ragged column.
      '--style', 'transcript',
      '--no-speakers',
      '--no-timestamps',
      '--overwrite',
      '-o', transcriptPath,
      audioPath,
    ];

    const run = await runWithDeadline(this.binPath, args, deadlineMs);

    if (run.timedOut) {
      // NOTE: killing `mw` does not cancel the job inside MacWhisper.app. A
      // retry will queue behind the orphan. Known and unsolved.
      logger.error({ audioPath, deadlineMs }, 'Transcription exceeded deadline');
      return err(
        createError(
          ErrorCodes.AUDIO_TRANSCRIPTION_FAILED,
          // Prefix is load-bearing: start.ts trips a per-message circuit
          // breaker on it, because killing mw does not cancel the job inside
          // MacWhisper.app and every later file would queue behind the orphan.
          `${DEADLINE_ERROR_PREFIX} Transcription exceeded ${deadlineMs}ms deadline`,
        ),
      );
    }

    if (run.code !== 0) {
      logger.error(
        { audioPath, code: run.code, error: run.error },
        'mw exited non-zero',
      );
      return err(
        createError(
          ErrorCodes.AUDIO_TRANSCRIPTION_FAILED,
          `mw exited ${run.code ?? 'null'}`,
          run.error,
        ),
      );
    }

    let raw: string;
    try {
      raw = await readFile(transcriptPath, 'utf8');
    } catch (error) {
      // Exit 0 with no output file means mw's contract changed under us.
      logger.error({ error, transcriptPath }, 'Transcript file unreadable');
      return err(
        createError(
          ErrorCodes.AUDIO_TRANSCRIPTION_FAILED,
          'Transcript file missing after successful exit',
          error,
        ),
      );
    }

    // Trim before testing emptiness — `--format txt` emits a trailing newline.
    const text = raw.trim();
    if (!text) {
      logger.info({ audioPath }, 'Transcription produced no speech');
      return err(
        createError(ErrorCodes.AUDIO_NO_SPEECH, 'No speech detected in recording'),
      );
    }

    logger.info(
      { audioPath, transcriptPath, chars: text.length },
      'Audio transcribed',
    );
    return ok(text);
  }
}

/**
 * Deadline for a transcription run.
 *
 * A flat timeout is wrong in both directions: 60s is sized for a short clip on
 * a warm MacWhisper, while a legal ten-minute note on a cold one would be
 * killed after doing most of the work. Scale it, with a floor that covers app
 * launch plus model load.
 */
export function deadlineFor(durationMs?: number): number {
  const base = 60_000;
  if (!durationMs || durationMs <= 0) return base;
  // Math.ceil is load-bearing, not tidiness. Node validates execFile's
  // `timeout` as an integer and throws ERR_OUT_OF_RANGE synchronously for a
  // fractional one — inside the promise executor, so it surfaces as a REJECTION
  // rather than an err() Result. Slack's duration_ms is arbitrary, so ~3 of 4
  // notes over two minutes produced a non-integer here and took the whole
  // message down with "an unexpected error occurred".
  return Math.max(base, Math.ceil(30_000 + durationMs / 4));
}

interface RunOutcome {
  code: number | null;
  timedOut: boolean;
  error?: unknown;
}

/**
 * Run a child process that is guaranteed to settle.
 *
 * `execFile`'s own `timeout` is not a deadline — it is a signal. If the child
 * is blocked in an uninterruptible wait (mw sitting on a MacWhisper modal: an
 * update prompt, a licence nag, a model download) it will not die, no 'close'
 * event fires, and a promisified execFile never settles at all.
 *
 * That matters more than it sounds: the caller runs inside the per-session
 * lock, whose `.finally()` release is downstream of this await. A promise that
 * never settles leaves the lock held forever, so every later message in that
 * thread posts "Queued..." and hangs, with no error anyone can see and no
 * recovery short of restarting the daemon.
 *
 * So: SIGKILL rather than SIGTERM, plus an independent timer that resolves on
 * its own even if the child outlives everything.
 */
function runWithDeadline(
  bin: string,
  args: string[],
  deadlineMs: number,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let hardTimer: NodeJS.Timeout | undefined;
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
        { timeout: deadlineMs, killSignal: 'SIGKILL' },
        () => {
          // Deliberately empty: stdout/stderr are unused (see class docstring),
          // and outcome is taken from the 'close'/'error' events below.
        },
      );
    } catch (error) {
      // execFile validates its arguments and can throw BEFORE spawning —
      // a bad timeout, a misconfigured GOLDFISH_MW_PATH. Inside a promise
      // executor that becomes a rejection, which would break this module's
      // "never throws" contract and drop the caller's entire message.
      finish({ code: null, timedOut: false, error });
      return;
    }

    hardTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone, or unkillable. Either way we stop waiting.
      }
      finish({ code: null, timedOut: true });
    }, deadlineMs + HARD_KILL_GRACE_MS);

    child.on('error', (error) => finish({ code: null, timedOut: false, error }));
    child.on('close', (code, signal) =>
      finish({
        code,
        // Judge by the clock, not the signal. A SIGKILL can also come from
        // maxBuffer overflow, an invalidated code signature after a MacWhisper
        // update, or someone's `kill -9` — logging those as "exceeded deadline"
        // sends the next reader down the wrong path.
        timedOut:
          code === null &&
          signal === 'SIGKILL' &&
          Date.now() - startedAt >= deadlineMs,
      }),
    );
  });
}

/**
 * Best-effort audio duration, for when Slack omits `duration_ms`.
 *
 * Slack populates it for voice notes but not necessarily for an ordinary
 * uploaded recording, and an unknown duration must not mean "unlimited" — that
 * is how an hour-long podcast reaches a transcriber running inside the session
 * lock. Returns undefined if it can't tell, and the caller fails closed.
 */
export async function probeDurationMs(
  audioPath: string,
): Promise<number | undefined> {
  try {
    await stat(audioPath);
  } catch {
    return undefined;
  }

  const run = await new Promise<string | undefined>((resolve) => {
    execFile(
      AFINFO_BIN,
      [audioPath],
      { timeout: 10_000, killSignal: 'SIGKILL' },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });

  if (!run) return undefined;
  const match = run.match(/estimated duration:\s*([0-9.]+)\s*sec/i);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : undefined;
}
