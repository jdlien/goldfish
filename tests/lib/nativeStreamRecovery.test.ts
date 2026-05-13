import { describe, it, expect, vi } from 'vitest';
import { postNativeStreamRecovery } from '../../src/lib/nativeStreamRecovery.js';

function createMockWebClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: 'ts-1' }),
    },
  };
}

function slackError(code: string): Error & { data: { error: string } } {
  const err = new Error(`An API error occurred: ${code}`) as any;
  err.code = 'slack_webapi_platform_error';
  err.data = { ok: false, error: code };
  return err;
}

describe('postNativeStreamRecovery', () => {
  it('posts a short recovery message with a clear prefix', async () => {
    const webClient = createMockWebClient();

    const result = await postNativeStreamRecovery({
      webClient: webClient as any,
      channel: 'C123',
      threadTs: 'T1',
      rawText: 'Recovered body',
    });

    expect(result).toEqual({ attempted: true, ok: true, postedTs: ['ts-1'] });
    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: 'T1',
      text: expect.stringContaining('Recovering interrupted response'),
    });
    expect(webClient.chat.postMessage.mock.calls[0][0].text).toContain('Recovered body');
  });

  it('splits long recovery text across Slack-sized messages', async () => {
    const webClient = createMockWebClient();
    webClient.chat.postMessage.mockImplementation(async () => ({
      ok: true,
      ts: `ts-${webClient.chat.postMessage.mock.calls.length}`,
    }));

    const result = await postNativeStreamRecovery({
      webClient: webClient as any,
      channel: 'C123',
      threadTs: 'T1',
      rawText: 'x '.repeat(5000),
    });

    expect(result.ok).toBe(true);
    expect(webClient.chat.postMessage.mock.calls.length).toBeGreaterThan(1);
    for (const [args] of webClient.chat.postMessage.mock.calls) {
      expect(args.text.length).toBeLessThanOrEqual(3900);
    }
  });

  it('formats markdown for regular Slack messages', async () => {
    const webClient = createMockWebClient();

    await postNativeStreamRecovery({
      webClient: webClient as any,
      channel: 'C123',
      threadTs: 'T1',
      rawText: '# Heading\nSee [OpenAI](https://openai.com)',
    });

    const text = webClient.chat.postMessage.mock.calls[0][0].text;
    expect(text).toContain('*Heading*');
    expect(text).toContain('<https://openai.com|OpenAI>');
  });

  it('returns all posted timestamps', async () => {
    const webClient = createMockWebClient();
    const postedTs: string[] = [];
    webClient.chat.postMessage.mockImplementation(async () => {
      const ts = `ts-${postedTs.length + 1}`;
      postedTs.push(ts);
      return { ok: true, ts };
    });

    const result = await postNativeStreamRecovery({
      webClient: webClient as any,
      channel: 'C123',
      threadTs: 'T1',
      rawText: 'x '.repeat(5000),
    });

    expect(result.postedTs).toEqual(postedTs);
    expect(result.postedTs.length).toBeGreaterThan(1);
  });

  it('retries transient HTTP failures', async () => {
    const webClient = createMockWebClient();
    webClient.chat.postMessage
      .mockRejectedValueOnce(Object.assign(new Error('http 500'), { statusCode: 500 }))
      .mockResolvedValueOnce({ ok: true, ts: 'after-retry' });

    const result = await postNativeStreamRecovery({
      webClient: webClient as any,
      channel: 'C123',
      threadTs: 'T1',
      rawText: 'Recovered body',
      retryDelaysMs: [0],
    });

    expect(result).toMatchObject({ attempted: true, ok: true, postedTs: ['after-retry'] });
    expect(webClient.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent Slack platform errors', async () => {
    const webClient = createMockWebClient();
    webClient.chat.postMessage.mockRejectedValue(slackError('not_in_channel'));

    const result = await postNativeStreamRecovery({
      webClient: webClient as any,
      channel: 'C123',
      threadTs: 'T1',
      rawText: 'Recovered body',
      retryDelaysMs: [0, 0],
    });

    expect(result.ok).toBe(false);
    expect(webClient.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('reports failure after transient retries are exhausted', async () => {
    const webClient = createMockWebClient();
    webClient.chat.postMessage.mockRejectedValue(
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    );

    const result = await postNativeStreamRecovery({
      webClient: webClient as any,
      channel: 'C123',
      threadTs: 'T1',
      rawText: 'Recovered body',
      retryDelaysMs: [0, 0],
    });

    expect(result.ok).toBe(false);
    expect(webClient.chat.postMessage).toHaveBeenCalledTimes(3);
  });
});
