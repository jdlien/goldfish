/**
 * TranscriptWriter — saves conversation exchanges to daily JSONL files
 * for the memory pipeline (daily synthesis, FTS5 indexing).
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { format } from 'date-fns';
import { createChildLogger } from '../lib/logger.js';
import { SESSIONS_PATH } from '../config.js';

const logger = createChildLogger('TranscriptWriter');

export interface TranscriptEntry {
  timestamp: string;
  slackChannel: string;
  slackThread: string;
  userMessage: string;
  assistantResponse: string;
  claudeSessionId: string | null;
  durationMs?: number;
  costUsd?: number;
}

/**
 * Append a conversation turn to today's session JSONL file.
 *
 * File: memory/sessions/YYYY-MM-DD.jsonl
 * One JSON object per line, one line per message exchange.
 */
export function writeTranscript(entry: TranscriptEntry): void {
  try {
    const today = format(new Date(), 'yyyy-MM-dd');
    const sessionFile = join(SESSIONS_PATH, `${today}.jsonl`);

    // Ensure directory exists
    const dir = dirname(sessionFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const line = JSON.stringify(entry) + '\n';
    appendFileSync(sessionFile, line, 'utf-8');

    logger.debug({ file: sessionFile, channel: entry.slackChannel }, 'Transcript saved');
  } catch (error) {
    // Don't let transcript failures break the bot
    logger.error({ error }, 'Failed to write transcript');
  }
}
