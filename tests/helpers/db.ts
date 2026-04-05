import { type Kysely } from 'kysely';
import type { Database } from '../../src/db/types.js';
import { getTestDb, runMigrations } from '../../src/db/index.js';
import { SqliteRepo } from '../../src/adapters/SqliteRepo.js';

export interface TestDb {
  db: Kysely<Database>;
  repo: SqliteRepo;
}

/**
 * Create a fresh in-memory database with migrations applied.
 * Call db.destroy() in afterEach to clean up.
 */
export async function createTestDb(): Promise<TestDb> {
  const db = getTestDb();
  await runMigrations(db);
  return { db, repo: new SqliteRepo(db) };
}
