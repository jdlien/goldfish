import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import type { Database as DatabaseSchema } from './types.js';
import { up as migration001 } from './migrations/001-initial.js';
import { up as migration002 } from './migrations/002-reminders.js';
import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('db');
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(__dirname, '..', '..', 'data', 'slack.db');

let dbInstance: Kysely<DatabaseSchema> | null = null;

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

  try {
    await migration001(db);
    await migration002(db);
    logger.info('Migrations completed successfully');
  } catch (error) {
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
