import type { Generated } from 'kysely';

/**
 * Database schema types for Kysely
 */

export interface SessionTable {
  id: string;
  slack_channel_id: string;
  slack_thread_ts: string | null;
  claude_session_id: string | null;
  agent_backend: 'claude' | 'codex' | null;
  agent_session_id: string | null;
  agent_session_active_at: number | null;
  agent_session_revision: Generated<number>;
  agent_backend_pinned: Generated<number>;
  run_lease_owner: string | null;
  run_lease_expires_at: number | null;
  created_at: number;
  last_active_at: number;
  last_synthesized_at: number | null;
}

export interface GoldfishMigrationTable {
  name: string;
  applied_at: number;
}

export interface MessageTable {
  id: string;
  session_id: string;
  slack_ts: string;
  direction: 'inbound' | 'outbound';
  content: string;
  created_at: number;
}

export interface ReminderTable {
  id: string;
  channel: string;
  message: string;
  cron: string | null;
  fire_at: number | null;
  recurring: number; // 0 = one-shot, 1 = recurring
  created_at: number;
  fired_at: number | null;
  context: string | null;
}

export interface Database {
  sessions: SessionTable;
  messages: MessageTable;
  reminders: ReminderTable;
  goldfish_migrations: GoldfishMigrationTable;
}
