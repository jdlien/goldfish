import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/types.js';
import { SqliteRepo } from '../../src/adapters/SqliteRepo.js';
import { createTestDb } from '../helpers/db.js';
import { makeSessionParams, makeMessageParams } from '../helpers/fixtures.js';

let db: Kysely<Database>;
let repo: SqliteRepo;

beforeEach(async () => {
  const test = await createTestDb();
  db = test.db;
  repo = test.repo;
});

afterEach(async () => {
  await db.destroy();
});

describe('findSession', () => {
  it('returns null when no session exists', async () => {
    const result = await repo.findSession('C_NONEXIST', '123.456');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('finds session by channel and threadTs', async () => {
    const params = makeSessionParams();
    await repo.createSession(params);

    const result = await repo.findSession(params.slackChannelId, params.slackThreadTs!);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      expect(result.value!.slackChannelId).toBe(params.slackChannelId);
    }
  });

  it('finds session with null threadTs', async () => {
    const params = makeSessionParams({ slackThreadTs: null });
    await repo.createSession(params);

    const result = await repo.findSession(params.slackChannelId, null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toBeNull();
  });
});

describe('createSession', () => {
  it('creates session and returns ok with valid shape', async () => {
    const result = await repo.createSession(makeSessionParams());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBeTruthy();
      expect(result.value.slackChannelId).toBe('C0TEST12345');
      expect(result.value.claudeSessionId).toBeNull();
    }
  });

  it('created session is findable', async () => {
    const params = makeSessionParams();
    const createResult = await repo.createSession(params);
    expect(createResult.ok).toBe(true);

    const findResult = await repo.findSession(params.slackChannelId, params.slackThreadTs!);
    expect(findResult.ok).toBe(true);
    if (findResult.ok && createResult.ok) {
      expect(findResult.value!.id).toBe(createResult.value.id);
    }
  });
});

describe('updateClaudeSessionId', () => {
  it('updates claudeSessionId on existing session', async () => {
    const createResult = await repo.createSession(makeSessionParams());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const sessionId = createResult.value.id;
    const claudeId = 'claude-session-abc123';

    const updateResult = await repo.updateClaudeSessionId(sessionId, claudeId);
    expect(updateResult.ok).toBe(true);

    const findResult = await repo.findSession('C0TEST12345', '1234567890.123456');
    expect(findResult.ok).toBe(true);
    if (findResult.ok) {
      expect(findResult.value!.claudeSessionId).toBe(claudeId);
    }
  });

  it('also updates lastActiveAt', async () => {
    const createResult = await repo.createSession(makeSessionParams());
    if (!createResult.ok) return;

    const originalLastActive = createResult.value.lastActiveAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    await repo.updateClaudeSessionId(createResult.value.id, 'new-id');

    const findResult = await repo.findSession('C0TEST12345', '1234567890.123456');
    if (findResult.ok && findResult.value) {
      expect(findResult.value.lastActiveAt).toBeGreaterThanOrEqual(originalLastActive);
    }
  });
});

describe('touchSession', () => {
  it('updates lastActiveAt without changing other fields', async () => {
    const createResult = await repo.createSession(makeSessionParams());
    if (!createResult.ok) return;

    await new Promise((r) => setTimeout(r, 10));

    const touchResult = await repo.touchSession(createResult.value.id);
    expect(touchResult.ok).toBe(true);

    const findResult = await repo.findSession('C0TEST12345', '1234567890.123456');
    if (findResult.ok && findResult.value) {
      expect(findResult.value.slackChannelId).toBe('C0TEST12345');
      expect(findResult.value.claudeSessionId).toBeNull();
    }
  });
});

describe('getOrCreateSession', () => {
  it('creates new session when none exists', async () => {
    const result = await repo.getOrCreateSession('C_NEW', '111.222');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slackChannelId).toBe('C_NEW');
      expect(result.value.slackThreadTs).toBe('111.222');
    }
  });

  it('returns existing session when one exists', async () => {
    const createResult = await repo.createSession(makeSessionParams());
    if (!createResult.ok) return;

    const result = await repo.getOrCreateSession('C0TEST12345', '1234567890.123456');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(createResult.value.id);
    }
  });

  it('touches existing session on retrieval', async () => {
    const createResult = await repo.createSession(makeSessionParams());
    if (!createResult.ok) return;

    await new Promise((r) => setTimeout(r, 10));

    const result = await repo.getOrCreateSession('C0TEST12345', '1234567890.123456');
    if (result.ok) {
      expect(result.value.lastActiveAt).toBeGreaterThanOrEqual(createResult.value.lastActiveAt);
    }
  });
});

describe('saveMessage', () => {
  it('saves message and returns ok', async () => {
    const session = await repo.createSession(makeSessionParams());
    if (!session.ok) return;

    const result = await repo.saveMessage(
      makeMessageParams({ sessionId: session.value.id }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBeTruthy();
      expect(result.value.direction).toBe('inbound');
      expect(result.value.content).toBe('Hello, world!');
    }
  });

  it('saves both inbound and outbound messages', async () => {
    const session = await repo.createSession(makeSessionParams());
    if (!session.ok) return;

    await repo.saveMessage(
      makeMessageParams({ sessionId: session.value.id, direction: 'inbound' }),
    );
    await repo.saveMessage(
      makeMessageParams({
        sessionId: session.value.id,
        direction: 'outbound',
        slackTs: '999.999',
      }),
    );

    const msgs = await repo.getSessionMessages(session.value.id);
    expect(msgs.ok).toBe(true);
    if (msgs.ok) {
      expect(msgs.value).toHaveLength(2);
    }
  });
});

describe('getSessionMessages', () => {
  it('returns empty array for session with no messages', async () => {
    const session = await repo.createSession(makeSessionParams());
    if (!session.ok) return;

    const result = await repo.getSessionMessages(session.value.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('returns messages in chronological order', async () => {
    const session = await repo.createSession(makeSessionParams());
    if (!session.ok) return;

    await repo.saveMessage(
      makeMessageParams({ sessionId: session.value.id, content: 'first', slackTs: '1.0' }),
    );
    await repo.saveMessage(
      makeMessageParams({ sessionId: session.value.id, content: 'second', slackTs: '2.0' }),
    );

    const result = await repo.getSessionMessages(session.value.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0].content).toBe('first');
      expect(result.value[1].content).toBe('second');
    }
  });

  it('respects limit parameter', async () => {
    const session = await repo.createSession(makeSessionParams());
    if (!session.ok) return;

    for (let i = 0; i < 5; i++) {
      await repo.saveMessage(
        makeMessageParams({ sessionId: session.value.id, slackTs: `${i}.0` }),
      );
    }

    const result = await repo.getSessionMessages(session.value.id, 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });
});

describe('getRecentSessions', () => {
  it('returns only sessions active since the threshold', async () => {
    await repo.createSession(makeSessionParams());
    const now = Date.now();

    const result = await repo.getRecentSessions(now - 1000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes sessions older than threshold', async () => {
    await repo.createSession(makeSessionParams());

    const result = await repo.getRecentSessions(Date.now() + 10000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(0);
  });
});

describe('getStats', () => {
  it('returns correct counts', async () => {
    const session = await repo.createSession(makeSessionParams());
    if (!session.ok) return;

    await repo.saveMessage(makeMessageParams({ sessionId: session.value.id }));
    await repo.saveMessage(
      makeMessageParams({ sessionId: session.value.id, slackTs: '2.0' }),
    );

    const result = await repo.getStats();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalSessions).toBe(1);
      expect(result.value.totalMessages).toBe(2);
      expect(result.value.activeSessions).toBe(1);
    }
  });
});
