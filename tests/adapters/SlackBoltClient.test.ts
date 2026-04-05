import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSlackClientFromEnv } from '../../src/adapters/SlackBoltClient.js';

describe('createSlackClientFromEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns err when SLACK_APP_TOKEN is missing', () => {
    delete process.env.SLACK_APP_TOKEN;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    const result = createSlackClientFromEnv();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_CONFIG');
      expect(result.error.message).toContain('SLACK_APP_TOKEN');
    }
  });

  it('returns err when SLACK_BOT_TOKEN is missing', () => {
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    delete process.env.SLACK_BOT_TOKEN;

    const result = createSlackClientFromEnv();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_CONFIG');
      expect(result.error.message).toContain('SLACK_BOT_TOKEN');
    }
  });

  it('returns ok with SlackBoltClient when both tokens are set', () => {
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    const result = createSlackClientFromEnv();
    expect(result.ok).toBe(true);
  });

  it('accepts optional SLACK_SIGNING_SECRET', () => {
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_SIGNING_SECRET = 'secret123';

    const result = createSlackClientFromEnv();
    expect(result.ok).toBe(true);
  });
});
