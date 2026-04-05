import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SlackFileDownloader,
  sanitizeFilename,
  type SlackFile,
} from '../../src/adapters/SlackFileDownloader.js';

// We need to mock config values so downloads go to a temp dir
let tempAttachmentsDir: string;

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>(
    '../../src/config.js',
  );
  return {
    ...actual,
    get ATTACHMENTS_PATH() {
      return tempAttachmentsDir;
    },
    MAX_FILE_SIZE_BYTES: 1024, // 1 KB for testing
  };
});

describe('sanitizeFilename', () => {
  it('strips directory traversal', () => {
    expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('/absolute/path/file.png')).toBe('file.png');
    expect(sanitizeFilename('C:\\Windows\\System32\\evil.exe')).toBe('evil.exe');
  });

  it('removes null bytes and control chars', () => {
    expect(sanitizeFilename('file\x00.png')).toBe('file.png');
    expect(sanitizeFilename('file\x1fname.txt')).toBe('filename.txt');
  });

  it('replaces whitespace with underscores', () => {
    expect(sanitizeFilename('my file name.png')).toBe('my_file_name.png');
    expect(sanitizeFilename('\tnewline\n.txt')).toBe('newline.txt');
  });

  it('falls back to "file" when input becomes empty', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('\x00\x00\x00')).toBe('file');
  });

  it('truncates very long names', () => {
    const longName = 'a'.repeat(500) + '.png';
    const result = sanitizeFilename(longName);
    expect(result.length).toBeLessThanOrEqual(200);
  });
});

describe('SlackFileDownloader', () => {
  let downloader: SlackFileDownloader;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempAttachmentsDir = await mkdtemp(join(tmpdir(), 'goldfish-test-'));
    downloader = new SlackFileDownloader('xoxb-test-token');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await rm(tempAttachmentsDir, { recursive: true, force: true });
  });

  function makeResponse(body: Buffer, status = 200): Response {
    return new Response(body, { status });
  }

  function makeFile(overrides: Partial<SlackFile> = {}): SlackFile {
    return {
      id: 'F12345',
      name: 'test.png',
      mimetype: 'image/png',
      filetype: 'png',
      size: 100,
      url_private: 'https://files.slack.com/files-pri/T0/F12345/test.png',
      ...overrides,
    };
  }

  describe('file type support', () => {
    it('accepts image/png', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from('fake png data')));
      const result = await downloader.download(makeFile({ mimetype: 'image/png' }));
      expect(result.ok).toBe(true);
    });

    it('accepts image/jpeg', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from('fake jpg')));
      const result = await downloader.download(makeFile({ mimetype: 'image/jpeg' }));
      expect(result.ok).toBe(true);
    });

    it('accepts application/pdf', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from('%PDF-1.4')));
      const result = await downloader.download(
        makeFile({ mimetype: 'application/pdf', name: 'doc.pdf' }),
      );
      expect(result.ok).toBe(true);
    });

    it('accepts text/* mimetypes', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from('hello')));
      const result = await downloader.download(
        makeFile({ mimetype: 'text/plain', name: 'notes.txt' }),
      );
      expect(result.ok).toBe(true);
    });

    it('accepts code via filetype shortcode when mimetype is generic', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from('print("hi")')));
      const result = await downloader.download(
        makeFile({
          mimetype: 'application/octet-stream',
          filetype: 'py',
          name: 'script.py',
        }),
      );
      expect(result.ok).toBe(true);
    });

    it('rejects zip files', async () => {
      const result = await downloader.download(
        makeFile({ mimetype: 'application/zip', filetype: 'zip', name: 'x.zip' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SLACK_FILE_UNSUPPORTED_TYPE');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects audio files', async () => {
      const result = await downloader.download(
        makeFile({ mimetype: 'audio/mp3', filetype: 'mp3', name: 'song.mp3' }),
      );
      expect(result.ok).toBe(false);
    });

    it('accepts HEIC (handled by conversion downstream)', async () => {
      // We can't actually run sips in tests, but we can verify the
      // mimetype passes the isSupported check
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from('fake heic')));
      const result = await downloader.download(
        makeFile({ mimetype: 'image/heic', name: 'photo.heic' }),
      );
      // Will fail at the sips conversion step since input isn't real HEIC,
      // but the type check passes
      if (!result.ok) {
        expect(result.error.code).toBe('HEIC_CONVERSION_FAILED');
      }
    });
  });

  describe('size limits', () => {
    it('rejects files over the size limit (pre-download)', async () => {
      const result = await downloader.download(makeFile({ size: 5000 })); // > 1 KB limit
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SLACK_FILE_TOO_LARGE');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects files that exceed limit after download', async () => {
      // Slack reports size 100 but returns 5000 bytes
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.alloc(5000)));
      const result = await downloader.download(makeFile({ size: 100 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SLACK_FILE_TOO_LARGE');
      }
    });
  });

  describe('download', () => {
    it('uses the bot token in the Authorization header', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from('data')));
      await downloader.download(makeFile());

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://files.slack.com/files-pri/T0/F12345/test.png',
        {
          headers: { Authorization: 'Bearer xoxb-test-token' },
        },
      );
    });

    it('prefers url_private_download when present', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from('data')));
      await downloader.download(
        makeFile({
          url_private: 'https://files.slack.com/pri.png',
          url_private_download: 'https://files.slack.com/download.png',
        }),
      );

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://files.slack.com/download.png',
        expect.any(Object),
      );
    });

    it('writes downloaded bytes to disk', async () => {
      const expectedContent = Buffer.from('real file content here');
      fetchSpy.mockResolvedValueOnce(makeResponse(expectedContent));

      const result = await downloader.download(makeFile());
      expect(result.ok).toBe(true);

      if (result.ok) {
        const written = await readFile(result.value.path);
        expect(written.equals(expectedContent)).toBe(true);
      }
    });

    it('returns SLACK_FILE_SCOPE_MISSING on 401', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from(''), 401));
      const result = await downloader.download(makeFile());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SLACK_FILE_SCOPE_MISSING');
      }
    });

    it('returns SLACK_FILE_SCOPE_MISSING on 403', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from(''), 403));
      const result = await downloader.download(makeFile());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SLACK_FILE_SCOPE_MISSING');
      }
    });

    it('returns SLACK_FILE_DOWNLOAD_FAILED on other HTTP errors', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from(''), 500));
      const result = await downloader.download(makeFile());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SLACK_FILE_DOWNLOAD_FAILED');
      }
    });

    it('returns SLACK_FILE_DOWNLOAD_FAILED when fetch throws', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network down'));
      const result = await downloader.download(makeFile());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SLACK_FILE_DOWNLOAD_FAILED');
      }
    });

    it('returns error when url_private is missing', async () => {
      const result = await downloader.download(
        makeFile({ url_private: undefined, url_private_download: undefined }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SLACK_FILE_DOWNLOAD_FAILED');
      }
    });

    it('writes files into YYYY-MM-DD subdirectory', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from('x')));
      const result = await downloader.download(makeFile());
      expect(result.ok).toBe(true);

      if (result.ok) {
        const today = new Date().toISOString().slice(0, 10);
        expect(result.value.path).toContain(`/${today}/`);
      }
    });

    it('sanitizes the saved filename', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(Buffer.from('x')));
      const result = await downloader.download(
        makeFile({ name: '../../../etc/passwd.png' }),
      );
      expect(result.ok).toBe(true);

      if (result.ok) {
        expect(result.value.path).not.toContain('../');
        expect(result.value.path).toContain('passwd.png');
      }
    });
  });
});
