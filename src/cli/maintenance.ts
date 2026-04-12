/**
 * Maintenance Tasks
 *
 * Handles non-Slack scheduled tasks: daily synthesis and memory indexing.
 * Called by the schedule runner for maintenance-type tasks.
 */

import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { createChildLogger } from '../lib/logger.js';
import { indexWorkspace } from '../lib/memoryIndexer.js';
import { WORKSPACE_PATH, SEARCH_DB_PATH } from '../config.js';
import type { ScheduleTask } from '../lib/scheduleParser.js';
import { initDb, closeDb } from '../db/index.js';
import { SqliteRepo } from '../adapters/SqliteRepo.js';

const logger = createChildLogger('cli:maintenance');

/**
 * Run a maintenance task (daily-synthesis or index-memory).
 */
export async function runMaintenanceTask(task: ScheduleTask): Promise<void> {
  switch (task.type) {
    case 'daily-synthesis':
      return runDailySynthesis(task);
    case 'index-memory':
      return runIndexMemory();
    case 'thread-synthesis':
      return runThreadSynthesis(task);
    default:
      throw new Error(`Unknown maintenance task type: ${task.type}`);
  }
}

/**
 * Run daily synthesis via the shell script.
 * The script handles yesterday's date, JSONL reading, Claude invocation, and file writing.
 */
async function runDailySynthesis(task: ScheduleTask): Promise<void> {
  console.log(chalk.bold('\n📝 Running daily synthesis...\n'));

  const scriptPath = join(process.cwd(), 'scripts', 'daily-synthesis.sh');
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    GOLDFISH_WORKSPACE: WORKSPACE_PATH,
  };

  // Pass model override via environment variable
  if (task.model) {
    env.GOLDFISH_SYNTHESIS_MODEL = task.model;
  }

  try {
    const output = execFileSync('bash', [scriptPath], {
      env,
      encoding: 'utf-8',
      timeout: 15 * 60 * 1000, // 15 minute timeout
    });

    console.log(chalk.dim(output.trim()));
    console.log(chalk.green('\n✓ Daily synthesis complete\n'));
    logger.info('Daily synthesis completed');
  } catch (err) {
    logger.error({ error: err }, 'Daily synthesis failed');
    throw err;
  }
}

/** Default idle threshold before synthesizing a thread (30 minutes) */
const THREAD_IDLE_MS = Number(process.env.GOLDFISH_THREAD_IDLE_MS ?? 30 * 60 * 1000);

/**
 * Find idle sessions and synthesize their transcripts into daily memory files.
 * Runs on a schedule (typically every few minutes). Finds threads that have been
 * idle for THREAD_IDLE_MS and have unsynthesized activity, then runs a per-thread
 * synthesis to append a summary to today's memory file.
 */
async function runThreadSynthesis(task: ScheduleTask): Promise<void> {
  const db = await initDb();
  const repo = new SqliteRepo(db);

  const result = await repo.getSessionsNeedingSynthesis(THREAD_IDLE_MS);
  await closeDb();

  if (!result.ok) {
    logger.error({ error: result.error }, 'Failed to query idle sessions');
    return;
  }

  const sessions = result.value;
  if (sessions.length === 0) return;

  console.log(chalk.bold(`\n🧠 Thread synthesis: ${sessions.length} idle session(s) to process\n`));

  const scriptPath = join(process.cwd(), 'scripts', 'thread-synthesis.sh');
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    GOLDFISH_WORKSPACE: WORKSPACE_PATH,
  };

  if (task.model) {
    env.GOLDFISH_SYNTHESIS_MODEL = task.model;
  }

  for (const session of sessions) {
    const sessionDesc = session.slackThreadTs
      ? `${session.slackChannelId}:${session.slackThreadTs}`
      : session.slackChannelId;

    try {
      logger.info({ sessionId: session.id, channel: sessionDesc }, 'Synthesizing idle thread');
      console.log(chalk.dim(`  Synthesizing: ${sessionDesc}`));

      execFileSync('bash', [
        scriptPath,
        session.id,
        session.slackChannelId,
        session.slackThreadTs ?? 'null',
        session.lastSynthesizedAt?.toString() ?? 'null',
      ], {
        env,
        encoding: 'utf-8',
        timeout: 5 * 60 * 1000, // 5 minute timeout per thread
      });

      // Mark as synthesized
      const markDb = await initDb();
      const markRepo = new SqliteRepo(markDb);
      await markRepo.markSessionSynthesized(session.id);
      await closeDb();

      console.log(chalk.green(`  ✓ ${sessionDesc}`));
    } catch (err) {
      logger.error({ error: err, sessionId: session.id }, 'Thread synthesis failed');
      console.error(chalk.red(`  ✗ ${sessionDesc}: ${err}`));
    }
  }

  console.log(chalk.green('\n✓ Thread synthesis pass complete\n'));
}

/**
 * Rebuild the FTS5 memory search index.
 */
async function runIndexMemory(): Promise<void> {
  console.log(chalk.bold('\n🔍 Rebuilding memory index...\n'));

  try {
    const stats = indexWorkspace(SEARCH_DB_PATH, WORKSPACE_PATH);

    console.log(chalk.dim(`  Indexed: ${stats.indexed} files (${stats.totalChunks} chunks)`));
    console.log(chalk.dim(`  Skipped: ${stats.skipped} unchanged`));
    console.log(chalk.dim(`  Removed: ${stats.removed} deleted`));
    console.log(chalk.green('\n✓ Memory index rebuilt\n'));
    logger.info(stats, 'Memory index rebuilt');
  } catch (err) {
    logger.error({ error: err }, 'Memory indexing failed');
    throw err;
  }
}
