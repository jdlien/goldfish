import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  serializeForJson,
  writeNativeStreamFailureRecord,
  type NativeStreamFailureRecord,
} from '../../src/lib/nativeStreamDiagnostics.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'goldfish-native-stream-diagnostics-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<NativeStreamFailureRecord> = {}): NativeStreamFailureRecord {
  const error = Object.assign(new Error('slack failed'), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: 'internal_error' },
    statusCode: 500,
  });

  return {
    timestamp: '2026-05-13T12:00:00.000Z',
    channelId: 'C123',
    threadTs: '111.222',
    messageTs: '333.444',
    sessionId: 'session-1',
    claudeSessionId: 'claude-1',
    deliveryStatus: {
      suspected: true,
      issues: [
        {
          reason: 'final_flush_failed',
          message: 'Final SDK buffer flush failed before stopStream',
          error,
          rawTextLength: 42,
          confirmedSentBytes: 0,
          currentStreamTextLength: 42,
          estimatedBufferedBytes: 42,
        },
      ],
      rawTextLength: 42,
      confirmedSentBytes: 0,
      unsentSuffixLength: 42,
      hasUnsentSuffix: true,
    },
    rawTextLength: 42,
    rawTextPreview: 'answer preview',
    recovery: {
      attempted: true,
      ok: false,
      postedTs: [],
      error,
    },
    ...overrides,
  };
}

describe('writeNativeStreamFailureRecord', () => {
  it('writes one JSONL record and creates the diagnostics directory', async () => {
    const diagnosticsPath = join(tempDir, 'nested', 'native-stream-failures.jsonl');

    await writeNativeStreamFailureRecord(makeRecord(), diagnosticsPath);

    const contents = await readFile(diagnosticsPath, 'utf8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      channelId: 'C123',
      threadTs: '111.222',
      messageTs: '333.444',
      sessionId: 'session-1',
      claudeSessionId: 'claude-1',
      rawTextPreview: 'answer preview',
    });
  });

  it('serializes Error fields inside delivery status and recovery objects', async () => {
    const diagnosticsPath = join(tempDir, 'native-stream-failures.jsonl');

    await writeNativeStreamFailureRecord(makeRecord(), diagnosticsPath);

    const parsed = JSON.parse(await readFile(diagnosticsPath, 'utf8'));
    const deliveryError = parsed.deliveryStatus.issues[0].error;
    const recoveryError = parsed.recovery.error;

    expect(deliveryError).toMatchObject({
      name: 'Error',
      message: 'slack failed',
      code: 'slack_webapi_platform_error',
      statusCode: 500,
      data: { ok: false, error: 'internal_error' },
    });
    expect(recoveryError).toMatchObject({
      name: 'Error',
      message: 'slack failed',
    });
  });

  it('swallows diagnostic write failures', async () => {
    await expect(
      writeNativeStreamFailureRecord(makeRecord(), tempDir),
    ).resolves.toBeUndefined();
  });
});

describe('serializeForJson', () => {
  it('handles circular objects', () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(serializeForJson(value)).toEqual({ self: '[Circular]' });
  });
});
