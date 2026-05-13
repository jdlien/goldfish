import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { DIAGNOSTICS_PATH } from '../config.js';
import { createChildLogger } from './logger.js';
import type { NativeStreamDeliveryStatus } from './SlackNativeStreamer.js';
import type { NativeStreamRecoveryResult } from './nativeStreamRecovery.js';

const logger = createChildLogger('nativeStreamDiagnostics');

export interface NativeStreamFailureRecord {
  timestamp: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  sessionId: string;
  claudeSessionId: string | null;
  deliveryStatus: NativeStreamDeliveryStatus;
  rawTextLength: number;
  rawTextPreview: string;
  recovery: NativeStreamRecoveryResult;
}

export async function writeNativeStreamFailureRecord(
  record: NativeStreamFailureRecord,
  diagnosticsPath = DIAGNOSTICS_PATH,
): Promise<void> {
  try {
    await mkdir(dirname(diagnosticsPath), { recursive: true });
    await appendFile(diagnosticsPath, `${JSON.stringify(serializeForJson(record))}\n`, 'utf8');
  } catch (error) {
    logger.warn({ error }, 'Failed to write native-stream diagnostic record');
  }
}

export function serializeForJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    const extra = value as Error & {
      code?: unknown;
      data?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(extra.code !== undefined ? { code: extra.code } : {}),
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      ...(extra.statusCode !== undefined ? { statusCode: extra.statusCode } : {}),
      ...(extra.data !== undefined ? { data: serializeForJson(extra.data, seen) } : {}),
    };
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => serializeForJson(item, seen));
    seen.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = serializeForJson(nested, seen);
  }
  seen.delete(value);
  return result;
}
