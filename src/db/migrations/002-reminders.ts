import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('reminders')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('channel', 'text', (col) => col.notNull())
    .addColumn('message', 'text', (col) => col.notNull())
    .addColumn('cron', 'text') // For recurring reminders
    .addColumn('fire_at', 'integer') // Unix ms, for one-shot reminders
    .addColumn('recurring', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('fired_at', 'integer') // Last fired timestamp (recurring)
    .addColumn('context', 'text') // Optional extra context for prompt
    .execute();

  await db.schema
    .createIndex('idx_reminders_fire_at')
    .ifNotExists()
    .on('reminders')
    .columns(['fire_at'])
    .execute();

  await db.schema
    .createIndex('idx_reminders_recurring')
    .ifNotExists()
    .on('reminders')
    .columns(['recurring'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('reminders').ifExists().execute();
}
