import { z } from 'zod';

/**
 * Session entity - maps Slack threads to provider sessions
 */

export const SessionSchema = z.object({
  id: z.string().uuid(),
  slackChannelId: z.string().min(1),
  slackThreadTs: z.string().nullable(), // NULL for root DM, thread_ts for threads
  claudeSessionId: z.string().nullable(), // Deprecated compatibility mirror for Claude only
  agentBackend: z.enum(['claude', 'codex']).nullable(),
  agentSessionId: z.string().nullable(),
  agentSessionActiveAt: z.number().int().nullable(),
  agentSessionRevision: z.number().int().nonnegative(),
  agentBackendPinned: z.boolean(),
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
    agentBackend: null,
    agentSessionId: null,
    agentSessionActiveAt: null,
    agentSessionRevision: 0,
    agentBackendPinned: false,
    createdAt: now,
    lastActiveAt: now,
  };
}
