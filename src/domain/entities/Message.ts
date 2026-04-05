import { z } from 'zod';

/**
 * Message entity - tracks conversation history
 */

export const MessageDirectionSchema = z.enum(['inbound', 'outbound']);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  slackTs: z.string().min(1), // Slack message timestamp
  direction: MessageDirectionSchema,
  content: z.string(),
  createdAt: z.number().int(), // Unix timestamp ms
});

export type Message = z.infer<typeof MessageSchema>;

export interface CreateMessageParams {
  sessionId: string;
  slackTs: string;
  direction: MessageDirection;
  content: string;
}

export function createMessage(params: CreateMessageParams): Message {
  return {
    id: crypto.randomUUID(),
    sessionId: params.sessionId,
    slackTs: params.slackTs,
    direction: params.direction,
    content: params.content,
    createdAt: Date.now(),
  };
}
