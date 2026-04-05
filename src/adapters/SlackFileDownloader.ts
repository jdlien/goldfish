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
}

export interface DownloadedFile {
  path: string;
  mimetype: string;
  size: number;
  originalName: string;
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

    // Download
    let buffer: Buffer;
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
      buffer = Buffer.from(arrayBuf);

      // Second size check in case Slack didn't report size upfront
      if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
        return err(
          createError(
            ErrorCodes.SLACK_FILE_TOO_LARGE,
            `Downloaded file is ${buffer.byteLength} bytes (limit ${MAX_FILE_SIZE_BYTES})`,
          ),
        );
      }
    } catch (error) {
      logger.error({ error, fileId: file.id }, 'File download failed');
      return err(
        createError(ErrorCodes.SLACK_FILE_DOWNLOAD_FAILED, 'Download failed', error),
      );
    }

    // Write to disk
    const safeName = sanitizeFilename(file.name ?? `${file.id}.bin`);
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
    });
  }

  private isSupported(file: SlackFile): boolean {
    const mimetype = (file.mimetype ?? '').toLowerCase();

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
