import { z } from 'zod';

/**
 * Session entity - maps Slack threads to Claude sessions
 */

export const SessionSchema = z.object({
  id: z.string().uuid(),
  slackChannelId: z.string().min(1),
  slackThreadTs: z.string().nullable(), // NULL for root DM, thread_ts for threads
  claudeSessionId: z.string().nullable(), // Claude Code session ID for --resume
  createdAt: z.number().int(), // Unix timestamp ms
  lastActiveAt: z.number().int(), // Unix timestamp ms
});

export type Session = z.infer<typeof SessionSchema>;

export interface CreateSessionParams {
  slackChannelId: string;
  slackThreadTs?: string | null;
}

export function createSession(params: CreateSessionParams): Session {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    slackChannelId: params.slackChannelId,
    slackThreadTs: params.slackThreadTs ?? null,
    claudeSessionId: null,
    createdAt: now,
    lastActiveAt: now,
  };
}
