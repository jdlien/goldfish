import { describe, it, expect } from 'vitest';
import { createMessage } from '../../../src/domain/entities/Message.js';

describe('createMessage', () => {
  it('generates a valid UUID id', () => {
    const msg = createMessage({
      sessionId: crypto.randomUUID(),
      slackTs: '123.456',
      direction: 'inbound',
      content: 'hello',
    });
    expect(msg.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('sets createdAt to approximately now', () => {
    const before = Date.now();
    const msg = createMessage({
      sessionId: crypto.randomUUID(),
      slackTs: '123.456',
      direction: 'outbound',
      content: 'hi',
    });
    expect(Math.abs(msg.createdAt - before)).toBeLessThan(1000);
  });

  it('preserves all input fields', () => {
    const sessionId = crypto.randomUUID();
    const msg = createMessage({
      sessionId,
      slackTs: '999.888',
      direction: 'inbound',
      content: 'test content',
    });
    expect(msg.sessionId).toBe(sessionId);
    expect(msg.slackTs).toBe('999.888');
    expect(msg.direction).toBe('inbound');
    expect(msg.content).toBe('test content');
  });
});
