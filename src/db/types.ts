import type { Generated } from 'kysely';

/**
 * Database schema types for Kysely
 */

export interface SessionTable {
  id: string;
  slack_channel_id: string;
  slack_thread_ts: string | null;
  claude_session_id: string | null;
  created_at: number;
  last_active_at: number;
}

export interface MessageTable {
  id: string;
  session_id: string;
  slack_ts: string;
  direction: 'inbound' | 'outbound';
  content: string;
  created_at: number;
}

export interface Database {
  sessions: SessionTable;
  messages: MessageTable;
}
