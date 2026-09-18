import { mkdir, writeFile, unlink } from 'fs/promises';
import { join, extname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  type Result,
  ok,
  err,
  createError,
  ErrorCodes,
} from '../domain/services/result.js';
import { createChildLogger } from '../lib/logger.js';
import { ATTACHMENTS_PATH, MAX_FILE_SIZE_BYTES } from '../config.js';

const logger = createChildLogger('SlackFileDownloader');
const execFileAsync = promisify(execFile);

/**
 * Shape of a file attachment on a Slack message event. Slack provides
 * many more fields; we only need these.
 */
export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  /** `slack_audio` marks a voice message (as opposed to an uploaded recording). */
  subtype?: string;
  /** Present on voice messages. NOT guaranteed on ordinary audio uploads. */
  duration_ms?: number;
}

export interface DownloadedFile {
  path: string;
  mimetype: string;
  size: number;
  originalName: string;
  /** True for Slack voice messages — content, not an attachment. */
  isVoiceMessage: boolean;
  /** Slack-reported duration, when it gave us one. */
  durationMs?: number;
}

/**
 * Mimetype allowlist — directly readable by Claude's Read tool.
 * HEIC/HEIF aren't in here because they get converted to JPEG first.
 */
const SUPPORTED_MIMETYPES = new Set([
  // Images (directly readable)
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  // PDF
  'application/pdf',
  // Structured data
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
]);

/**
 * Slack filetype shortcodes (like `py`, `md`, `ts`) that we accept
 * when Slack sends them with a generic or unknown mimetype. Claude's
 * Read tool handles all of these via text.
 */
const SUPPORTED_FILETYPES = new Set([
  // Text & markup
  'text', 'plain', 'md', 'markdown', 'mdx', 'rst', 'html', 'htm', 'xml', 'csv', 'tsv',
  // Code
  'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish',
  'sql', 'lua', 'r', 'scala', 'clj', 'ex', 'exs', 'elm', 'dart', 'nim',
  // Config
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  // Web
  'css', 'scss', 'sass', 'less', 'vue', 'svelte',
]);

const HEIC_MIMETYPES = new Set(['image/heic', 'image/heif']);
const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);

/** Slack's `subtype` for a voice message recorded in the client. */
const SLACK_AUDIO_SUBTYPE = 'slack_audio';

/**
 * Pause before re-fetching audio that failed on the first try.
 *
 * `url_private_download` for a voice note points at a server-side transcode
 * (`files-tmb`, and named `.mp4` even though Slack presents the file as
 * `.m4a`). The daemon fetches within about a second of the message event, and
 * whether that transcode is ready that early is unverified — so one cheap
 * retry, rather than losing the only copy of what someone said.
 */
const AUDIO_RETRY_DELAY_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Downloads files from Slack using bot token auth on url_private.
 * Handles HEIC → JPEG conversion for iPhone photos, filename
 * sanitization, size limits, and typed error results.
 */
export class SlackFileDownloader {
  private botToken: string;

  constructor(botToken: string) {
    this.botToken = botToken;
  }

  /**
   * Download a Slack file and return its local path. Performs:
   * - mimetype/filetype allowlist check
   * - size limit check (20 MB default)
   * - authenticated HTTPS GET on url_private
   * - filename sanitization (path traversal, null bytes)
   * - HEIC → JPEG conversion via sips for iPhone photos
   */
  async download(file: SlackFile): Promise<Result<DownloadedFile>> {
    // Size check (pre-download, using Slack-reported size)
    if (file.size !== undefined && file.size > MAX_FILE_SIZE_BYTES) {
      return err(
        createError(
          ErrorCodes.SLACK_FILE_TOO_LARGE,
          `File ${file.name ?? file.id} is ${file.size} bytes (limit ${MAX_FILE_SIZE_BYTES})`,
        ),
      );
    }

    // Type check
    if (!this.isSupported(file)) {
      return err(
        createError(
          ErrorCodes.SLACK_FILE_UNSUPPORTED_TYPE,
          `File type not supported: mimetype=${file.mimetype}, filetype=${file.filetype}`,
        ),
      );
    }

    const url = file.url_private_download ?? file.url_private;
    if (!url) {
      return err(
        createError(
          ErrorCodes.SLACK_FILE_DOWNLOAD_FAILED,
          `File ${file.id} has no url_private`,
        ),
      );
    }

    // Non-audio keeps the original single-shot behaviour. Audio gets one retry
    // and then a fallback to url_private — see AUDIO_RETRY_DELAY_MS.
    const attempts: Array<{ url: string; delayMs: number }> = [
      { url, delayMs: 0 },
    ];
    if (this.isAudio(file)) {
      attempts.push({ url, delayMs: AUDIO_RETRY_DELAY_MS });
      if (file.url_private && file.url_private !== url) {
        attempts.push({ url: file.url_private, delayMs: 0 });
      }
    }

    let buffer: Buffer | undefined;
    let lastError: ReturnType<typeof createError> | undefined;

    for (const attempt of attempts) {
      if (attempt.delayMs) await sleep(attempt.delayMs);
      const result = await this.fetchBytes(attempt.url, file);
      if (result.ok) {
        buffer = result.value;
        break;
      }
      lastError = result.error;

      // Only transient failures deserve another go. A file we already know is
      // oversized won't shrink, and a 401/403 won't grant itself a scope — and
      // retrying the latter both burns 1.5s inside the session lock and risks
      // overwriting the scope-missing error with a vaguer one from a later
      // attempt, which is the single error the owner needs to see to fix it.
      if (
        result.error.code === ErrorCodes.SLACK_FILE_TOO_LARGE ||
        result.error.code === ErrorCodes.SLACK_FILE_SCOPE_MISSING
      ) {
        break;
      }
    }

    if (!buffer) {
      return err(
        lastError ??
          createError(ErrorCodes.SLACK_FILE_DOWNLOAD_FAILED, 'Download failed'),
      );
    }

    // Write to disk
    //
    // Audio gets a neutral, generated name instead of the sender's. Two
    // reasons: `sanitizeFilename` strips separators and control chars but
    // leaves quotes, `$`, backticks and semicolons intact, and the path is
    // then handed to a GUI app whose string handling we don't control; and it
    // truncates at 200 UTF-16 units rather than bytes, so a 200-character CJK
    // name is 600 bytes against a 255-byte NAME_MAX — and the `.txt` transcript
    // sidecar adds four more. Non-audio naming is deliberately untouched.
    const safeName = this.isAudio(file)
      ? `${file.id}.${safeAudioExtension(file)}`
      : sanitizeFilename(file.name ?? `${file.id}.bin`);
    const dateDir = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dir = join(ATTACHMENTS_PATH, dateDir);
    const filename = `${Date.now()}-${safeName}`;
    const fullPath = join(dir, filename);

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, buffer);
    } catch (error) {
      logger.error({ error, fullPath }, 'Failed to write downloaded file');
      return err(
        createError(
          ErrorCodes.SLACK_FILE_DOWNLOAD_FAILED,
          'Failed to save file to disk',
          error,
        ),
      );
    }

    // HEIC → JPEG conversion if needed
    const isHeic =
      HEIC_MIMETYPES.has((file.mimetype ?? '').toLowerCase()) ||
      HEIC_EXTENSIONS.has(extname(safeName).toLowerCase());

    if (isHeic) {
      const converted = await convertHeicToJpeg(fullPath);
      if (!converted.ok) {
        // Clean up the HEIC on failure
        await unlink(fullPath).catch(() => {});
        return converted;
      }
      return ok({
        path: converted.value,
        mimetype: 'image/jpeg',
        size: buffer.byteLength,
        originalName: file.name ?? safeName,
        isVoiceMessage: false,
      });
    }

    logger.info(
      { fileId: file.id, path: fullPath, size: buffer.byteLength },
      'File downloaded',
    );

    return ok({
      path: fullPath,
      mimetype: file.mimetype ?? 'application/octet-stream',
      size: buffer.byteLength,
      originalName: file.name ?? safeName,
      isVoiceMessage: this.isVoiceMessage(file),
      durationMs: file.duration_ms,
    });
  }

  /**
   * One authenticated GET. Error mapping is unchanged from the original
   * single-shot implementation; it was extracted so audio can retry.
   */
  private async fetchBytes(
    url: string,
    file: SlackFile,
  ): Promise<Result<Buffer>> {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.botToken}`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        return err(
          createError(
            ErrorCodes.SLACK_FILE_SCOPE_MISSING,
            `Slack rejected file download (${response.status}) — bot likely missing files:read scope`,
          ),
        );
      }

      if (!response.ok) {
        return err(
          createError(
            ErrorCodes.SLACK_FILE_DOWNLOAD_FAILED,
            `Download failed: HTTP ${response.status}`,
          ),
        );
      }

      const arrayBuf = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      // Second size check in case Slack didn't report size upfront.
      //
      // Note for audio: Slack's reported `size` is the ORIGINAL upload, while
      // `url_private_download` serves a smaller transcode (309514 vs 171187
      // bytes on a measured voice note). The pre-download check is therefore
      // conservative — it is not measuring the bytes you receive.
      if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
        return err(
          createError(
            ErrorCodes.SLACK_FILE_TOO_LARGE,
            `Downloaded file is ${buffer.byteLength} bytes (limit ${MAX_FILE_SIZE_BYTES})`,
          ),
        );
      }

      return ok(buffer);
    } catch (error) {
      logger.error({ error, fileId: file.id }, 'File download failed');
      return err(
        createError(ErrorCodes.SLACK_FILE_DOWNLOAD_FAILED, 'Download failed', error),
      );
    }
  }

  /**
   * A Slack voice message. Checked on `subtype` rather than mimetype, because
   * the subtype is the thing Slack actually promises: a client shipping a voice
   * note as `video/mp4` (plausible, given the transcode is named `.mp4`) must
   * not be rejected by the allowlist before this is ever consulted.
   */
  isVoiceMessage(file: SlackFile): boolean {
    return (file.subtype ?? '').toLowerCase() === SLACK_AUDIO_SUBTYPE;
  }

  /** Voice message, or any ordinary audio upload. */
  isAudio(file: SlackFile): boolean {
    return (
      this.isVoiceMessage(file) ||
      (file.mimetype ?? '').toLowerCase().startsWith('audio/')
    );
  }

  private isSupported(file: SlackFile): boolean {
    const mimetype = (file.mimetype ?? '').toLowerCase();

    // Audio is transcribed on ingest rather than read directly.
    if (this.isAudio(file)) return true;

    // HEIC handled via conversion
    if (HEIC_MIMETYPES.has(mimetype)) return true;
    if (HEIC_EXTENSIONS.has(extname(file.name ?? '').toLowerCase())) return true;

    // Direct mimetype allowlist
    if (SUPPORTED_MIMETYPES.has(mimetype)) return true;

    // text/* mimetype prefix (covers code, markdown, csv, html, etc.)
    if (mimetype.startsWith('text/')) return true;

    // Filetype shortcode fallback (Slack sometimes sends generic mimetype)
    const filetype = (file.filetype ?? '').toLowerCase();
    if (filetype && SUPPORTED_FILETYPES.has(filetype)) return true;

    return false;
  }
}

/**
 * Sanitize a filename to prevent path traversal and filesystem issues.
 * Removes path separators, null bytes, and other control chars.
 */
export function sanitizeFilename(name: string): string {
  // Strip directory components (path traversal defense)
  const basename = name.replace(/^.*[\\/]/, '');
  // Remove control chars and null bytes
  const stripped = basename.replace(/[\x00-\x1f\x7f]/g, '');
  // Replace whitespace with underscores, limit length
  const normalized = stripped.replace(/\s+/g, '_').slice(0, 200);
  // If empty after sanitization, use a fallback
  return normalized || 'file';
}

/**
 * Extension for a generated audio filename.
 *
 * Validated, not sanitized: only a short alphanumeric token is accepted, so
 * nothing a sender controls can introduce a quote, space or separator. Falls
 * back through the mimetype subtype to a neutral literal.
 */
export function safeAudioExtension(file: SlackFile): string {
  const filetype = (file.filetype ?? '').toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(filetype)) return filetype;

  const subtype = (file.mimetype ?? '').toLowerCase().split('/')[1] ?? '';
  const cleaned = subtype.replace(/[^a-z0-9]/g, '');
  if (cleaned.length >= 1 && cleaned.length <= 8) return cleaned;

  return 'audio';
}

/**
 * Convert a HEIC file to JPEG using macOS's built-in sips tool.
 * Returns the path to the new JPEG file. Deletes the original HEIC
 * on success.
 */
async function convertHeicToJpeg(heicPath: string): Promise<Result<string>> {
  const jpegPath = heicPath.replace(/\.(heic|heif)$/i, '.jpg');

  try {
    await execFileAsync('sips', ['-s', 'format', 'jpeg', heicPath, '--out', jpegPath], {
      timeout: 30_000,
    });
  } catch (error) {
    logger.error({ error, heicPath }, 'sips HEIC conversion failed');
    return err(
      createError(
        ErrorCodes.HEIC_CONVERSION_FAILED,
        'HEIC → JPEG conversion failed',
        error,
      ),
    );
  }

  // Delete the original HEIC
  await unlink(heicPath).catch((error) => {
    logger.warn({ error, heicPath }, 'Failed to delete original HEIC');
  });

  logger.info({ jpegPath }, 'HEIC converted to JPEG');
  return ok(jpegPath);
}
