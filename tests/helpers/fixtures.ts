import type { CreateSessionParams } from '../../src/domain/entities/Session.js';
import type { CreateMessageParams } from '../../src/domain/entities/Message.js';
import type { TranscriptEntry } from '../../src/adapters/TranscriptWriter.js';

export function makeSessionParams(
  overrides: Partial<CreateSessionParams> = {},
): CreateSessionParams {
  return {
    slackChannelId: 'C0TEST12345',
    slackThreadTs: '1234567890.123456',
    ...overrides,
  };
}

export function makeMessageParams(
  overrides: Partial<CreateMessageParams> = {},
): CreateMessageParams {
  return {
    sessionId: crypto.randomUUID(),
    slackTs: '1234567890.123456',
    direction: 'inbound',
    content: 'Hello, world!',
    ...overrides,
  };
}

export function makeTranscriptEntry(
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    timestamp: new Date().toISOString(),
    slackChannel: 'C0TEST12345',
    slackThread: '1234567890.123456',
    userMessage: 'Hello',
    assistantResponse: 'Hi there!',
    claudeSessionId: crypto.randomUUID(),
    durationMs: 1500,
    costUsd: 0,
    ...overrides,
  };
}

export function makeClaudeJsonOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    result: 'Hello from Claude!',
    session_id: crypto.randomUUID(),
    cost_usd: 0,
    num_turns: 1,
    ...overrides,
  });
}
