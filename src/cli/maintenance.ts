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
      timeout: 5 * 60 * 1000, // 5 minute timeout
    });

    console.log(chalk.dim(output.trim()));
    console.log(chalk.green('\n✓ Daily synthesis complete\n'));
    logger.info('Daily synthesis completed');
  } catch (err) {
    logger.error({ error: err }, 'Daily synthesis failed');
    throw err;
  }
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
