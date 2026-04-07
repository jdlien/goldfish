import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { randomUUID } from 'crypto';
import {
  type Session,
  type Message,
  createSession,
  createMessage,
  type CreateSessionParams,
  type CreateMessageParams,
} from '../domain/index.js';
import type { ReminderTable } from '../db/types.js';
import {
  type Result,
  ok,
  err,
  createError,
  ErrorCodes,
} from '../domain/services/result.js';
import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('SqliteRepo');

/**
 * SQLite repository for sessions and messages
 */
export class SqliteRepo {
  constructor(private db: Kysely<Database>) {}

  // --- Sessions ---

  /**
   * Find session by Slack channel and thread
   */
  async findSession(
    channelId: string,
    threadTs: string | null
  ): Promise<Result<Session | null>> {
    try {
      let query = this.db
        .selectFrom('sessions')
        .selectAll()
        .where('slack_channel_id', '=', channelId);

      if (threadTs) {
        query = query.where('slack_thread_ts', '=', threadTs);
      } else {
        query = query.where('slack_thread_ts', 'is', null);
      }

      const row = await query.executeTakeFirst();

      if (!row) {
        return ok(null);
      }

      return ok({
        id: row.id,
        slackChannelId: row.slack_channel_id,
        slackThreadTs: row.slack_thread_ts,
        claudeSessionId: row.claude_session_id,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
      });
    } catch (error) {
      logger.error({ error, channelId, threadTs }, 'Failed to find session');
      return err(
        createError(ErrorCodes.DATABASE_ERROR, 'Failed to find session', error)
      );
    }
  }

  /**
   * Create a new session
   */
  async createSession(params: CreateSessionParams): Promise<Result<Session>> {
    try {
      const session = createSession(params);

      await this.db
        .insertInto('sessions')
        .values({
          id: session.id,
          slack_channel_id: session.slackChannelId,
          slack_thread_ts: session.slackThreadTs,
          claude_session_id: session.claudeSessionId,
          created_at: session.createdAt,
          last_active_at: session.lastActiveAt,
        })
        .execute();

      logger.info(
        { sessionId: session.id, channelId: params.slackChannelId },
        'Created new session'
      );

      return ok(session);
    } catch (error) {
      logger.error({ error, params }, 'Failed to create session');
      return err(
        createError(
          ErrorCodes.DATABASE_ERROR,
          'Failed to create session',
          error
        )
      );
    }
  }

  /**
   * Update session's Claude session ID
   */
  async updateClaudeSessionId(
    sessionId: string,
    claudeSessionId: string
  ): Promise<Result<void>> {
    try {
      await this.db
        .updateTable('sessions')
        .set({
          claude_session_id: claudeSessionId,
          last_active_at: Date.now(),
        })
        .where('id', '=', sessionId)
        .execute();

      logger.debug({ sessionId, claudeSessionId }, 'Updated Claude session ID');

      return ok(undefined);
    } catch (error) {
      logger.error({ error, sessionId }, 'Failed to update Claude session ID');
      return err(
        createError(
          ErrorCodes.DATABASE_ERROR,
          'Failed to update Claude session ID',
          error
        )
      );
    }
  }

  /**
   * Touch session (update last active time)
   */
  async touchSession(sessionId: string): Promise<Result<void>> {
    try {
      await this.db
        .updateTable('sessions')
        .set({ last_active_at: Date.now() })
        .where('id', '=', sessionId)
        .execute();

      return ok(undefined);
    } catch (error) {
      logger.error({ error, sessionId }, 'Failed to touch session');
      return err(
        createError(ErrorCodes.DATABASE_ERROR, 'Failed to touch session', error)
      );
    }
  }

  /**
   * Get or create session for a Slack thread
   */
  async getOrCreateSession(
    channelId: string,
    threadTs: string | null
  ): Promise<Result<Session>> {
    const findResult = await this.findSession(channelId, threadTs);
    if (!findResult.ok) return findResult;

    if (findResult.value) {
      // Touch existing session
      await this.touchSession(findResult.value.id);
      return ok(findResult.value);
    }

    // Create new session
    return this.createSession({
      slackChannelId: channelId,
      slackThreadTs: threadTs,
    });
  }

  // --- Messages ---

  /**
   * Save a message
   */
  async saveMessage(params: CreateMessageParams): Promise<Result<Message>> {
    try {
      const message = createMessage(params);

      await this.db
        .insertInto('messages')
        .values({
          id: message.id,
          session_id: message.sessionId,
          slack_ts: message.slackTs,
          direction: message.direction,
          content: message.content,
          created_at: message.createdAt,
        })
        .execute();

      logger.debug(
        { messageId: message.id, direction: message.direction },
        'Saved message'
      );

      return ok(message);
    } catch (error) {
      logger.error({ error, params }, 'Failed to save message');
      return err(
        createError(ErrorCodes.DATABASE_ERROR, 'Failed to save message', error)
      );
    }
  }

  /**
   * Get recent messages for a session
   */
  async getSessionMessages(
    sessionId: string,
    limit: number = 10
  ): Promise<Result<Message[]>> {
    try {
      const rows = await this.db
        .selectFrom('messages')
        .selectAll()
        .where('session_id', '=', sessionId)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute();

      const messages = rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        slackTs: row.slack_ts,
        direction: row.direction as 'inbound' | 'outbound',
        content: row.content,
        createdAt: row.created_at,
      }));

      // Return in chronological order
      return ok(messages.reverse());
    } catch (error) {
      logger.error({ error, sessionId }, 'Failed to get session messages');
      return err(
        createError(
          ErrorCodes.DATABASE_ERROR,
          'Failed to get session messages',
          error
        )
      );
    }
  }

  /**
   * Get recent sessions (for session continuity)
   * Returns sessions from the specified time range, ordered by last activity
   */
  async getRecentSessions(
    sinceMs: number,
    limit: number = 10
  ): Promise<Result<Session[]>> {
    try {
      const rows = await this.db
        .selectFrom('sessions')
        .selectAll()
        .where('last_active_at', '>=', sinceMs)
        .orderBy('last_active_at', 'desc')
        .limit(limit)
        .execute();

      const sessions = rows.map((row) => ({
        id: row.id,
        slackChannelId: row.slack_channel_id,
        slackThreadTs: row.slack_thread_ts,
        claudeSessionId: row.claude_session_id,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
      }));

      logger.debug({ count: sessions.length, sinceMs }, 'Retrieved recent sessions');

      return ok(sessions);
    } catch (error) {
      logger.error({ error, sinceMs }, 'Failed to get recent sessions');
      return err(
        createError(
          ErrorCodes.DATABASE_ERROR,
          'Failed to get recent sessions',
          error
        )
      );
    }
  }

  /**
   * Get sessions with their last messages for context
   * Useful for morning briefings to surface "unfinished" conversations
   */
  async getSessionsWithLastMessages(
    sinceMs: number,
    limit: number = 5
  ): Promise<Result<Array<{ session: Session; lastMessages: Message[] }>>> {
    try {
      // First get recent sessions
      const sessionsResult = await this.getRecentSessions(sinceMs, limit);
      if (!sessionsResult.ok) return sessionsResult;

      // Then get last 3 messages for each
      const results: Array<{ session: Session; lastMessages: Message[] }> = [];

      for (const session of sessionsResult.value) {
        const messagesResult = await this.getSessionMessages(session.id, 3);
        if (messagesResult.ok) {
          results.push({
            session,
            lastMessages: messagesResult.value,
          });
        }
      }

      return ok(results);
    } catch (error) {
      logger.error({ error, sinceMs }, 'Failed to get sessions with messages');
      return err(
        createError(
          ErrorCodes.DATABASE_ERROR,
          'Failed to get sessions with messages',
          error
        )
      );
    }
  }

  /**
   * Get session statistics
   */
  async getStats(): Promise<
    Result<{ totalSessions: number; totalMessages: number; activeSessions: number }>
  > {
    try {
      const sessionsCount = await this.db
        .selectFrom('sessions')
        .select(({ fn }) => fn.count<number>('id').as('count'))
        .executeTakeFirst();

      const messagesCount = await this.db
        .selectFrom('messages')
        .select(({ fn }) => fn.count<number>('id').as('count'))
        .executeTakeFirst();

      // Active = last active within 24 hours
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const activeCount = await this.db
        .selectFrom('sessions')
        .select(({ fn }) => fn.count<number>('id').as('count'))
        .where('last_active_at', '>', oneDayAgo)
        .executeTakeFirst();

      return ok({
        totalSessions: Number(sessionsCount?.count ?? 0),
        totalMessages: Number(messagesCount?.count ?? 0),
        activeSessions: Number(activeCount?.count ?? 0),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get stats');
      return err(
        createError(ErrorCodes.DATABASE_ERROR, 'Failed to get stats', error)
      );
    }
  }

  // --- Reminders ---

  /**
   * Create a reminder (one-shot or recurring)
   */
  async createReminder(params: {
    channel: string;
    message: string;
    fireAt?: number;
    cron?: string;
    recurring?: boolean;
    context?: string;
  }): Promise<Result<ReminderTable>> {
    try {
      const reminder: ReminderTable = {
        id: randomUUID(),
        channel: params.channel,
        message: params.message,
        cron: params.cron ?? null,
        fire_at: params.fireAt ?? null,
        recurring: params.recurring ? 1 : 0,
        created_at: Date.now(),
        fired_at: null,
        context: params.context ?? null,
      };

      await this.db.insertInto('reminders').values(reminder).execute();

      logger.info({ reminderId: reminder.id, fireAt: reminder.fire_at, cron: reminder.cron }, 'Created reminder');
      return ok(reminder);
    } catch (error) {
      logger.error({ error, params }, 'Failed to create reminder');
      return err(createError(ErrorCodes.DATABASE_ERROR, 'Failed to create reminder', error));
    }
  }

  /**
   * Get one-shot reminders that are due (fire_at <= now, not yet fired)
   */
  async getDueReminders(nowMs: number): Promise<Result<ReminderTable[]>> {
    try {
      const rows = await this.db
        .selectFrom('reminders')
        .selectAll()
        .where('recurring', '=', 0)
        .where('fire_at', '<=', nowMs)
        .where('fired_at', 'is', null)
        .execute();

      return ok(rows);
    } catch (error) {
      logger.error({ error }, 'Failed to get due reminders');
      return err(createError(ErrorCodes.DATABASE_ERROR, 'Failed to get due reminders', error));
    }
  }

  /**
   * Get all recurring reminders
   */
  async getRecurringReminders(): Promise<Result<ReminderTable[]>> {
    try {
      const rows = await this.db
        .selectFrom('reminders')
        .selectAll()
        .where('recurring', '=', 1)
        .execute();

      return ok(rows);
    } catch (error) {
      logger.error({ error }, 'Failed to get recurring reminders');
      return err(createError(ErrorCodes.DATABASE_ERROR, 'Failed to get recurring reminders', error));
    }
  }

  /**
   * Mark a one-shot reminder as fired and delete it
   */
  async deleteReminder(id: string): Promise<Result<void>> {
    try {
      await this.db.deleteFrom('reminders').where('id', '=', id).execute();
      logger.info({ reminderId: id }, 'Deleted reminder');
      return ok(undefined);
    } catch (error) {
      logger.error({ error, id }, 'Failed to delete reminder');
      return err(createError(ErrorCodes.DATABASE_ERROR, 'Failed to delete reminder', error));
    }
  }

  /**
   * Update fired_at for a recurring reminder
   */
  async markReminderFired(id: string, firedAt: number): Promise<Result<void>> {
    try {
      await this.db
        .updateTable('reminders')
        .set({ fired_at: firedAt })
        .where('id', '=', id)
        .execute();
      return ok(undefined);
    } catch (error) {
      logger.error({ error, id }, 'Failed to mark reminder fired');
      return err(createError(ErrorCodes.DATABASE_ERROR, 'Failed to mark reminder fired', error));
    }
  }

  /**
   * List all reminders (for CLI display)
   */
  async listReminders(): Promise<Result<ReminderTable[]>> {
    try {
      const rows = await this.db
        .selectFrom('reminders')
        .selectAll()
        .orderBy('created_at', 'desc')
        .execute();

      return ok(rows);
    } catch (error) {
      logger.error({ error }, 'Failed to list reminders');
      return err(createError(ErrorCodes.DATABASE_ERROR, 'Failed to list reminders', error));
    }
  }
}
