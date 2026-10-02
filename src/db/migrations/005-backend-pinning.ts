import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('sessions')
    .addColumn('agent_backend_pinned', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(_db: Kysely<Database>): Promise<void> {
  // Retain thread-routing intent on rollback; SQLite column removal would be
  // destructive and old binaries safely ignore the additional column.
}
