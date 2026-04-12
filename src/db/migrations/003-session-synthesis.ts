import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // Add synthesis tracking to sessions
  // last_synthesized_at: when this session's transcript was last written to memory
  // null = never synthesized
  await db.schema
    .alterTable('sessions')
    .addColumn('last_synthesized_at', 'integer')
    .execute()
    .catch(() => {
      // Column already exists (idempotent)
    });
}

export async function down(db: Kysely<Database>): Promise<void> {
  // SQLite doesn't support DROP COLUMN before 3.35.0
  // For safety, this is a no-op
}
