import { webApi } from '@slack/bolt';
import { createChildLogger } from './logger.js';
import { formatForSlack, splitSlackMessage } from './slackFormatter.js';

type WebClient = webApi.WebClient;

const logger = createChildLogger('nativeStreamRecovery');
const RECOVERY_PREFIX =
  '_Recovering interrupted response. The native Slack stream may have dropped content:_';
const DEFAULT_RETRY_DELAYS_MS = [250, 1000, 2500];

export interface NativeStreamRecoveryResult {
  attempted: boolean;
  ok: boolean;
  postedTs: string[];
  error?: unknown;
}

export async function postNativeStreamRecovery(params: {
  webClient: WebClient;
  channel: string;
  threadTs: string;
  rawText: string;
  retryDelaysMs?: number[];
}): Promise<NativeStreamRecoveryResult> {
  if (!params.rawText.trim()) {
    return { attempted: false, ok: true, postedTs: [] };
  }

  const formatted = formatForSlack(`${RECOVERY_PREFIX}\n\n${params.rawText}`);
  const chunks = splitSlackMessage(formatted).filter((chunk) => chunk.trim().length > 0);
  const postedTs: string[] = [];

  try {
    for (const text of chunks) {
      const result = await postMessageWithRetry(
        params.webClient,
        {
          channel: params.channel,
          thread_ts: params.threadTs,
          text,
        },
        params.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
      );
      if (result.ts) postedTs.push(result.ts);
    }
    return { attempted: true, ok: true, postedTs };
  } catch (error) {
    logger.error({ error, postedCount: postedTs.length }, 'Native stream recovery post failed');
    return { attempted: true, ok: false, postedTs, error };
  }
}

async function postMessageWithRetry(
  webClient: WebClient,
  args: { channel: string; thread_ts: string; text: string },
  retryDelaysMs: number[],
): Promise<{ ts?: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await webClient.chat.postMessage(args);
      if (!result.ok || !result.ts) {
        const error = new Error(`Slack postMessage failed: ${result.error ?? 'unknown error'}`);
        Object.assign(error, { data: result });
        throw error;
      }
      return { ts: result.ts };
    } catch (error) {
      const canRetry = attempt < retryDelaysMs.length && isRetryableSlackPostError(error);
      if (!canRetry) throw error;

      const delayMs = retryDelaysMs[attempt] ?? 0;
      logger.warn(
        { error, attempt: attempt + 1, delayMs },
        'Transient native stream recovery post failed; retrying',
      );
      if (delayMs > 0) {
        await delay(delayMs);
      }
    }
  }
}

function isRetryableSlackPostError(error: unknown): boolean {
  const status = getHttpStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  if (getSlackPlatformError(error)) {
    return false;
  }

  const code = getStringProperty(error, 'code');
  return (
    code === undefined ||
    code === 'slack_webapi_request_error' ||
    code === 'slack_webapi_http_error' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  );
}

function getSlackPlatformError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const slackError = (data as { error?: unknown }).error;
  return typeof slackError === 'string' ? slackError : undefined;
}

function getHttpStatus(error: unknown): number | undefined {
  return (
    getNumberProperty(error, 'statusCode') ??
    getNumberProperty(error, 'status') ??
    getNumberProperty((error as { data?: unknown })?.data, 'statusCode') ??
    getNumberProperty((error as { data?: unknown })?.data, 'status') ??
    getNumberProperty((error as { response?: unknown })?.response, 'statusCode') ??
    getNumberProperty((error as { response?: unknown })?.response, 'status')
  );
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'number' ? property : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
