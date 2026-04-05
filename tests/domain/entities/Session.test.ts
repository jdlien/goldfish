import { describe, it, expect } from 'vitest';
import { createSession } from '../../../src/domain/entities/Session.js';

describe('createSession', () => {
  it('generates a valid UUID id', () => {
    const session = createSession({ slackChannelId: 'C123' });
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('sets timestamps to approximately now', () => {
    const before = Date.now();
    const session = createSession({ slackChannelId: 'C123' });
    const after = Date.now();
    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.createdAt).toBeLessThanOrEqual(after);
    expect(session.lastActiveAt).toBe(session.createdAt);
  });

  it('defaults claudeSessionId to null', () => {
    const session = createSession({ slackChannelId: 'C123' });
    expect(session.claudeSessionId).toBeNull();
  });

  it('defaults slackThreadTs to null when not provided', () => {
    const session = createSession({ slackChannelId: 'C123' });
    expect(session.slackThreadTs).toBeNull();
  });

  it('sets slackThreadTs when provided', () => {
    const session = createSession({
      slackChannelId: 'C123',
      slackThreadTs: '1234567890.123456',
    });
    expect(session.slackThreadTs).toBe('1234567890.123456');
  });
});
