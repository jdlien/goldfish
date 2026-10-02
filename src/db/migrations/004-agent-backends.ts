import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('sessions').addColumn('agent_backend', 'text').execute();
  await db.schema.alterTable('sessions').addColumn('agent_session_id', 'text').execute();
  await db.schema.alterTable('sessions').addColumn('agent_session_active_at', 'integer').execute();
  await db.schema
    .alterTable('sessions')
    .addColumn('agent_session_revision', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable('sessions').addColumn('run_lease_owner', 'text').execute();
  await db.schema.alterTable('sessions').addColumn('run_lease_expires_at', 'integer').execute();

  await db
    .updateTable('sessions')
    .set((eb) => ({
      agent_backend: 'claude',
      agent_session_id: eb.ref('claude_session_id'),
      agent_session_active_at: eb.ref('last_active_at'),
    }))
    .where('claude_session_id', 'is not', null)
    .execute();
}

export async function down(_db: Kysely<Database>): Promise<void> {
  // Retain provider-neutral session data on rollback. SQLite column removal is
  // deliberately not automated because it would be destructive.
}
