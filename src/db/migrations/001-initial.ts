import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // Sessions table - maps Slack threads to Claude sessions
  await db.schema
    .createTable('sessions')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('slack_channel_id', 'text', (col) => col.notNull())
    .addColumn('slack_thread_ts', 'text')
    .addColumn('claude_session_id', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('last_active_at', 'integer', (col) => col.notNull())
    .execute();

  // Index for finding sessions by Slack channel/thread
  await db.schema
    .createIndex('idx_sessions_slack')
    .ifNotExists()
    .on('sessions')
    .columns(['slack_channel_id', 'slack_thread_ts'])
    .execute();

  // Messages table - conversation history
  await db.schema
    .createTable('messages')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('session_id', 'text', (col) =>
      col.notNull().references('sessions.id')
    )
    .addColumn('slack_ts', 'text', (col) => col.notNull())
    .addColumn('direction', 'text', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  // Index for finding messages by session
  await db.schema
    .createIndex('idx_messages_session')
    .ifNotExists()
    .on('messages')
    .columns(['session_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('messages').ifExists().execute();
  await db.schema.dropTable('sessions').ifExists().execute();
}
