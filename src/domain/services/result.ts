/**
 * Result type for explicit error handling
 */

export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface AppError {
  code: string;
  message: string;
  cause?: unknown;
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<E extends AppError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function createError(
  code: string,
  message: string,
  cause?: unknown,
): AppError {
  return { code, message, cause };
}

export const ErrorCodes = {
  SLACK_CONNECTION_FAILED: 'SLACK_CONNECTION_FAILED',
  SLACK_SEND_FAILED: 'SLACK_SEND_FAILED',
  SLACK_UPLOAD_FAILED: 'SLACK_UPLOAD_FAILED',
  CLAUDE_SPAWN_FAILED: 'CLAUDE_SPAWN_FAILED',
  CLAUDE_TIMEOUT: 'CLAUDE_TIMEOUT',
  CLAUDE_PARSE_ERROR: 'CLAUDE_PARSE_ERROR',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INVALID_CONFIG: 'INVALID_CONFIG',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  TRANSCRIPT_WRITE_FAILED: 'TRANSCRIPT_WRITE_FAILED',
  CLAUDE_STREAM_ERROR: 'CLAUDE_STREAM_ERROR',
  SLACK_FILE_DOWNLOAD_FAILED: 'SLACK_FILE_DOWNLOAD_FAILED',
  SLACK_FILE_TOO_LARGE: 'SLACK_FILE_TOO_LARGE',
  SLACK_FILE_UNSUPPORTED_TYPE: 'SLACK_FILE_UNSUPPORTED_TYPE',
  SLACK_FILE_SCOPE_MISSING: 'SLACK_FILE_SCOPE_MISSING',
  HEIC_CONVERSION_FAILED: 'HEIC_CONVERSION_FAILED',
  /**
   * Audio transcription failed — the machine broke (mw missing, non-zero exit,
   * deadline, unreadable output). Distinct from AUDIO_NO_SPEECH.
   *
   * NOT to be confused with TRANSCRIPT_WRITE_FAILED above, which is about the
   * *session* transcript (the Claude conversation log in TranscriptWriter.ts).
   * Same English word, unrelated concept.
   */
  AUDIO_TRANSCRIPTION_FAILED: 'AUDIO_TRANSCRIPTION_FAILED',
  /** Transcription succeeded but the recording contained no speech. */
  AUDIO_NO_SPEECH: 'AUDIO_NO_SPEECH',
  /** A scanned PDF could not be given a text layer. */
  PDF_OCR_FAILED: 'PDF_OCR_FAILED',
  /** A scanned PDF has more pages than we'll OCR inside the session lock. */
  PDF_OCR_TOO_LARGE: 'PDF_OCR_TOO_LARGE',
} as const;
