import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import type { Database as DatabaseSchema } from './types.js';
import { up as migration001 } from './migrations/001-initial.js';
import { up as migration002 } from './migrations/002-reminders.js';
import { up as migration003 } from './migrations/003-session-synthesis.js';
import { up as migration004 } from './migrations/004-agent-backends.js';
import { up as migration005 } from './migrations/005-backend-pinning.js';
import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('db');
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(__dirname, '..', '..', 'data', 'slack.db');

let dbInstance: Kysely<DatabaseSchema> | null = null;

const MIGRATION_LOCK_TIMEOUT_MS = 10_000;
const MIGRATION_LOCK_RETRY_MS = 25;

function isSqliteBusy(error: unknown): boolean {
  return (
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'SQLITE_BUSY') ||
    String(error).includes('database is locked')
  );
}

async function acquireMigrationLock(db: Kysely<DatabaseSchema>): Promise<number> {
  const pragma = await sql<{ timeout: number }>`PRAGMA busy_timeout`.execute(db);
  const previousBusyTimeout = Number(pragma.rows[0]?.timeout ?? 0);

  // A synchronous better-sqlite3 busy wait can block another migration running
  // in this Node process from reaching COMMIT. Poll asynchronously instead.
  await sql.raw('PRAGMA busy_timeout = 0').execute(db);
  const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await sql.raw('BEGIN IMMEDIATE').execute(db);
      return previousBusyTimeout;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) {
        await restoreBusyTimeout(db, previousBusyTimeout).catch(() => {});
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_RETRY_MS));
    }
  }
}

async function restoreBusyTimeout(
  db: Kysely<DatabaseSchema>,
  timeout: number,
): Promise<void> {
  const safeTimeout = Number.isSafeInteger(timeout) && timeout >= 0 ? timeout : 0;
  await sql.raw(`PRAGMA busy_timeout = ${safeTimeout}`).execute(db);
}

/**
 * Get or create the database instance
 */
export function getDb(dbPath: string = DEFAULT_DB_PATH): Kysely<DatabaseSchema> {
  if (dbInstance) {
    return dbInstance;
  }

  // Ensure data directory exists
  const dataDir = dirname(dbPath);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const sqlite = new Database(dbPath);

  // Configure SQLite for performance
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('cache_size = -64000'); // 64MB cache
  sqlite.pragma('busy_timeout = 5000'); // 5s timeout

  dbInstance = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });

  logger.info({ dbPath }, 'Database connection established');

  return dbInstance;
}

/**
 * Run database migrations
 */
export async function runMigrations(db: Kysely<DatabaseSchema>): Promise<void> {
  logger.info('Running database migrations...');

  let transactionStarted = false;
  let previousBusyTimeout: number | null = null;
  try {
    // Kysely's default SQLite transaction is deferred, which lets two
    // Goldfish processes both inspect an empty ledger before either writes.
    // Take the database write lock up front so the second process waits, then
    // re-inspects the schema and ledger after the first process commits.
    previousBusyTimeout = await acquireMigrationLock(db);
    transactionStarted = true;

    const before = await db.introspection.getTables();
    const existing = new Map(before.map((table) => [table.name, table]));
    const schemaObjects = new Set(
      (await sql<{ name: string }>`
        select name from sqlite_master
        where type in ('table', 'index') and name not like 'sqlite_%'
      `.execute(db)).rows.map((row) => row.name),
    );

    await db.schema
      .createTable('goldfish_migrations')
      .ifNotExists()
      .addColumn('name', 'text', (col) => col.primaryKey())
      .addColumn('applied_at', 'integer', (col) => col.notNull())
      .execute();

    const recorded = new Set(
      (await db.selectFrom('goldfish_migrations').select('name').execute()).map((row) => row.name),
    );

    // Older Goldfish releases ran idempotent migrations without a ledger.
    // Record only schema that is visibly present before applying new work.
    const baseline: string[] = [];
    if (
      existing.has('sessions') &&
      existing.has('messages') &&
      schemaObjects.has('idx_sessions_slack') &&
      schemaObjects.has('idx_messages_session')
    ) baseline.push('001-initial');
    if (
      existing.has('reminders') &&
      schemaObjects.has('idx_reminders_fire_at') &&
      schemaObjects.has('idx_reminders_recurring')
    ) baseline.push('002-reminders');
    if (existing.get('sessions')?.columns.some((column) => column.name === 'last_synthesized_at')) {
      baseline.push('003-session-synthesis');
    }
    for (const name of baseline) {
      if (!recorded.has(name)) {
        await db.insertInto('goldfish_migrations').values({ name, applied_at: Date.now() }).execute();
        recorded.add(name);
      }
    }

    // Goldfish only migrates forward automatically. The exported `down`
    // functions are development aids, not a supported production rollback;
    // restore a database backup when a deployed migration must be reversed.
    const migrations = [
      ['001-initial', migration001],
      ['002-reminders', migration002],
      ['003-session-synthesis', migration003],
      ['004-agent-backends', migration004],
      ['005-backend-pinning', migration005],
    ] as const;

    for (const [name, migrate] of migrations) {
      if (recorded.has(name)) continue;
      await migrate(db);
      await db
        .insertInto('goldfish_migrations')
        .values({ name, applied_at: Date.now() })
        .execute();
    }
    await sql.raw('COMMIT').execute(db);
    transactionStarted = false;
    await restoreBusyTimeout(db, previousBusyTimeout);
    previousBusyTimeout = null;
    logger.info('Migrations completed successfully');
  } catch (error) {
    if (transactionStarted) {
      await sql.raw('ROLLBACK').execute(db).catch(() => {});
    }
    if (previousBusyTimeout !== null) {
      await restoreBusyTimeout(db, previousBusyTimeout).catch(() => {});
    }
    logger.error({ error }, 'Migration failed');
    throw error;
  }
}

/**
 * Initialize database with migrations
 */
export async function initDb(dbPath?: string): Promise<Kysely<DatabaseSchema>> {
  const db = getDb(dbPath);
  await runMigrations(db);
  return db;
}

/**
 * Close database connection
 */
export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.destroy();
    dbInstance = null;
    logger.info('Database connection closed');
  }
}

/**
 * Get database for testing (in-memory)
 */
export function getTestDb(): Kysely<DatabaseSchema> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');

  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}
