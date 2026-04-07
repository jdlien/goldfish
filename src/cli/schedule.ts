/**
 * Schedule Command
 *
 * Reads schedule.yaml and runs any tasks due this minute.
 * Designed to be called every minute by a single cron entry:
 *
 *   * * * * * cd /path/to/goldfish && node dist/index.js schedule run
 *
 * Uses a lock file to prevent overlapping runs.
 */

import chalk from 'chalk';
import { join } from 'path';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { loadSchedule, toCron, cronMatchesNow, type ScheduleTask } from '../lib/scheduleParser.js';
import { initiate } from './initiate.js';
import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('cli:schedule');

export interface ScheduleRunOptions {
  config?: string;
  dryRun?: boolean;
}

export interface ScheduleListOptions {
  config?: string;
}

const LOCK_DIR = join(process.cwd(), '.schedule-locks');
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes — assume stale after this

/**
 * Check if a task is currently locked (running).
 */
function isLocked(taskName: string): boolean {
  const lockFile = join(LOCK_DIR, `${taskName}.lock`);
  if (!existsSync(lockFile)) return false;

  try {
    const content = readFileSync(lockFile, 'utf-8');
    const startedAt = parseInt(content, 10);
    if (Date.now() - startedAt > LOCK_STALE_MS) {
      // Stale lock — remove it
      unlinkSync(lockFile);
      logger.warn({ taskName }, 'Removed stale lock');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a lock for a task. Returns true if acquired.
 */
function acquireLock(taskName: string): boolean {
  const { mkdirSync } = require('fs');
  try { mkdirSync(LOCK_DIR, { recursive: true }); } catch { /* exists */ }

  const lockFile = join(LOCK_DIR, `${taskName}.lock`);
  if (isLocked(taskName)) return false;

  writeFileSync(lockFile, String(Date.now()));
  return true;
}

/**
 * Release a task lock.
 */
function releaseLock(taskName: string): void {
  const lockFile = join(LOCK_DIR, `${taskName}.lock`);
  try { unlinkSync(lockFile); } catch { /* already gone */ }
}

/**
 * Find the schedule.yaml config file.
 */
function resolveConfigPath(configOpt?: string): string {
  if (configOpt) return configOpt;

  // Check common locations
  const candidates = [
    join(process.cwd(), 'schedule.yaml'),
    join(process.cwd(), 'schedule.yml'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    'No schedule.yaml found. Create one or specify --config path.'
  );
}

/**
 * Run all tasks whose schedule matches the current minute.
 */
export async function scheduleRun(options: ScheduleRunOptions): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const config = loadSchedule(configPath);
  const now = new Date();

  const activeTasks = config.tasks.filter((t) => t.enabled !== false);
  const dueTasks = activeTasks.filter((task) => {
    const cronExpr = toCron(task);
    return cronMatchesNow(cronExpr, now);
  });

  if (dueTasks.length === 0) {
    // Normal for most minutes — silent exit
    return;
  }

  for (const task of dueTasks) {
    const cronExpr = toCron(task);

    if (options.dryRun) {
      console.log(chalk.yellow(`[DRY RUN] Would run: ${task.name} (${cronExpr})`));
      continue;
    }

    if (isLocked(task.name)) {
      console.log(chalk.dim(`⏭  ${task.name} — already running, skipping`));
      logger.info({ task: task.name }, 'Skipped — already running');
      continue;
    }

    console.log(chalk.bold(`🐟 Running: ${task.name}`));
    logger.info({ task: task.name, cron: cronExpr }, 'Firing scheduled task');

    if (!acquireLock(task.name)) {
      console.log(chalk.dim(`⏭  ${task.name} — lock contention, skipping`));
      continue;
    }

    try {
      await initiate({
        type: task.type,
        channel: task.channel,
        context: task.context,
      });
    } catch (err) {
      logger.error({ task: task.name, error: err }, 'Scheduled task failed');
      console.error(chalk.red(`✗ ${task.name} failed:`), err);
    } finally {
      releaseLock(task.name);
    }
  }
}

/**
 * List all configured schedule tasks with their cron expressions.
 */
export async function scheduleList(options: ScheduleListOptions): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const config = loadSchedule(configPath);

  console.log(chalk.bold(`\n📅 Schedule (${configPath})\n`));

  const maxName = Math.max(...config.tasks.map((t) => t.name.length));

  for (const task of config.tasks) {
    const cronExpr = toCron(task);
    const enabled = task.enabled !== false;
    const status = enabled ? chalk.green('✓') : chalk.dim('✗');
    const name = task.name.padEnd(maxName);
    const schedule = describeSchedule(task);

    console.log(`  ${status} ${chalk.bold(name)}  ${chalk.cyan(schedule)}  ${chalk.dim(cronExpr)}`);
  }

  console.log();
}

/**
 * Generate a human-readable description of a task's schedule.
 */
function describeSchedule(task: ScheduleTask): string {
  if (task.cron) return `cron: ${task.cron}`;

  const parts: string[] = [];

  if (task.at) parts.push(`at ${task.at}`);
  if (task.every) parts.push(`every ${task.every}`);
  if (task.between) parts.push(`between ${task.between}`);
  if (task.days && task.days !== 'daily') parts.push(task.days);

  return parts.join(', ') || 'no schedule';
}
