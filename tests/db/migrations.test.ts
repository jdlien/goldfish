import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sql, Kysely, SqliteDialect, type Kysely as KyselyType } from 'kysely';
import type { Database } from '../../src/db/types.js';
import { getTestDb, runMigrations } from '../../src/db/index.js';
import { up as migration001 } from '../../src/db/migrations/001-initial.js';
import { up as migration002 } from '../../src/db/migrations/002-reminders.js';
import { up as migration003 } from '../../src/db/migrations/003-session-synthesis.js';

let db: KyselyType<Database> | undefined;

afterEach(async () => {
  await db?.destroy();
  db = undefined;
});

describe('migration ledger and provider backfill', () => {
  it('upgrades a pre-ledger database and backfills Claude sessions once', async () => {
    db = getTestDb();
    await migration001(db);
    await migration002(db);
    await migration003(db);
    await sql`
      insert into sessions (
        id, slack_channel_id, slack_thread_ts, claude_session_id,
        created_at, last_active_at, last_synthesized_at
      ) values ('old-session', 'C1', '1.2', 'claude-old', 10, 20, null)
    `.execute(db);

    await runMigrations(db);
    await runMigrations(db);

    const row = await db.selectFrom('sessions').selectAll().where('id', '=', 'old-session').executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      agent_backend: 'claude',
      agent_session_id: 'claude-old',
      agent_session_active_at: 20,
      agent_session_revision: 0,
      agent_backend_pinned: 0,
    });
    const ledger = await db.selectFrom('goldfish_migrations').selectAll().execute();
    expect(ledger.map((entry) => entry.name).sort()).toEqual([
      '001-initial',
      '002-reminders',
      '003-session-synthesis',
      '004-agent-backends',
      '005-backend-pinning',
    ]);
  });

  it('serializes concurrent upgrades before inspecting the ledger', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goldfish-migrations-'));
    const dbPath = join(directory, 'goldfish.sqlite');
    const connect = () => {
      const sqlite = new BetterSqlite3(dbPath);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('busy_timeout = 5000');
      return new Kysely<Database>({
        dialect: new SqliteDialect({ database: sqlite }),
      });
    };

    const seed = connect();
    await migration001(seed);
    await migration002(seed);
    await migration003(seed);
    await seed.destroy();

    const first = connect();
    const second = connect();
    try {
      const results = await Promise.allSettled([
        runMigrations(first),
        runMigrations(second),
      ]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const ledger = await first.selectFrom('goldfish_migrations').select('name').execute();
      expect(new Set(ledger.map((entry) => entry.name))).toEqual(new Set([
        '001-initial',
        '002-reminders',
        '003-session-synthesis',
        '004-agent-backends',
        '005-backend-pinning',
      ]));
    } finally {
      await first.destroy();
      await second.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not baseline an interrupted legacy migration with a missing index', async () => {
    db = getTestDb();
    await migration001(db);
    await migration002(db);
    await migration003(db);
    await sql.raw('drop index idx_messages_session').execute(db);

    await runMigrations(db);

    const indexes = await sql<{ name: string }>`
      select name from sqlite_master where type = 'index'
    `.execute(db);
    expect(indexes.rows.map((row) => row.name)).toContain('idx_messages_session');
  });
});
