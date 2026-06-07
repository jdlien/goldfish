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
import { dirname, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'fs';
import {
  loadSchedule,
  toCron,
  cronMatchesNow,
  cronDayMatches,
  localDateKey,
  isHumanAtTask,
  targetDateTimeForToday,
  INITIATE_TYPES,
  type ScheduleTask,
  type InitiateTaskType,
} from '../lib/scheduleParser.js';
import { initiate } from './initiate.js';
import { runMaintenanceTask } from './maintenance.js';
import { initDb, closeDb } from '../db/index.js';
import { SqliteRepo } from '../adapters/SqliteRepo.js';
import { createChildLogger } from '../lib/logger.js';
import { WORKSPACE_PATH } from '../config.js';

const logger = createChildLogger('cli:schedule');

export interface ScheduleRunOptions {
  config?: string;
  dryRun?: boolean;
  /** Internal test seam; the CLI never exposes this. */
  now?: Date;
}

export interface ScheduleListOptions {
  config?: string;
}

const LOCK_STALE_MS = 20 * 60 * 1000; // 20 minutes — must exceed longest task timeout (15 min for synthesis)

function lockDir(): string {
  return join(process.cwd(), '.schedule-locks');
}

export type DueReason = 'exact' | 'catch-up';

export interface ScheduleTaskState {
  task?: string;
  lastScheduledDate?: string;
  lastAttemptedAt?: string;
  reason?: DueReason;
}

export interface ScheduleStateStore {
  read(taskName: string): ScheduleTaskState;
  write(taskName: string, state: ScheduleTaskState): void;
}

export interface DueScheduleTask {
  task: ScheduleTask;
  cronExpr: string;
  reason: DueReason;
  scheduledDate?: string;
  targetTime?: string;
}

export class FileScheduleStateStore implements ScheduleStateStore {
  constructor(private readonly stateDir: string) {}

  pathForTask(taskName: string): string {
    return join(this.stateDir, `${encodeURIComponent(taskName)}.last-run.json`);
  }

  read(taskName: string): ScheduleTaskState {
    const stateFile = this.pathForTask(taskName);
    if (!existsSync(stateFile)) return {};

    try {
      return JSON.parse(readFileSync(stateFile, 'utf-8')) as ScheduleTaskState;
    } catch (error) {
      logger.warn({ taskName, stateFile, error }, 'Ignoring unreadable schedule state');
      return {};
    }
  }

  write(taskName: string, state: ScheduleTaskState): void {
    mkdirSync(this.stateDir, { recursive: true });

    const stateFile = this.pathForTask(taskName);
    const tempFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempFile, JSON.stringify(state, null, 2));
    renameSync(tempFile, stateFile);
  }
}

function localDateTimeKey(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offsetRemainder = String(absOffset % 60).padStart(2, '0');

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const millis = String(date.getMilliseconds()).padStart(3, '0');

  return `${localDateKey(date)}T${hours}:${minutes}:${seconds}.${millis}${sign}${offsetHours}:${offsetRemainder}`;
}

function localTimeKey(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Check if a task is currently locked (running).
 */
function isLocked(taskName: string): boolean {
  const lockFile = join(lockDir(), `${taskName}.lock`);
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
  try { mkdirSync(lockDir(), { recursive: true }); } catch { /* exists */ }

  const lockFile = join(lockDir(), `${taskName}.lock`);
  if (isLocked(taskName)) return false;

  writeFileSync(lockFile, String(Date.now()));
  return true;
}

/**
 * Release a task lock.
 */
function releaseLock(taskName: string): void {
  const lockFile = join(lockDir(), `${taskName}.lock`);
  try { unlinkSync(lockFile); } catch { /* already gone */ }
}

/**
 * Find the schedule.yaml config file.
 */
export function resolveConfigPath(configOpt?: string): string {
  if (configOpt) return configOpt;

  // Prefer the user workspace, but keep the repo cwd as a fallback for older setups.
  const candidates = [
    join(WORKSPACE_PATH, 'schedule.yaml'),
    join(WORKSPACE_PATH, 'schedule.yml'),
    join(process.cwd(), 'schedule.yaml'),
    join(process.cwd(), 'schedule.yml'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `No schedule.yaml found. Checked ${WORKSPACE_PATH} and ${process.cwd()}. ` +
    `Create ${join(WORKSPACE_PATH, 'schedule.yaml')} or specify --config path.`
  );
}

/**
 * Decide whether a task is due at the given local time.
 */
export function getTaskDueReason(
  task: ScheduleTask,
  now: Date,
  state: ScheduleTaskState = {}
): DueScheduleTask | null {
  const cronExpr = toCron(task);

  if (!isHumanAtTask(task) || !INITIATE_TYPES.includes(task.type)) {
    return cronMatchesNow(cronExpr, now)
      ? { task, cronExpr, reason: 'exact' }
      : null;
  }

  if (!cronDayMatches(cronExpr, now)) return null;

  const target = targetDateTimeForToday(task, now);
  if (!target) return null;

  const scheduledDate = localDateKey(now);
  const targetTime = localTimeKey(target);

  if (state.lastScheduledDate === scheduledDate) return null;

  if (cronMatchesNow(cronExpr, now)) {
    return { task, cronExpr, reason: 'exact', scheduledDate, targetTime };
  }

  if (now >= target) {
    return { task, cronExpr, reason: 'catch-up', scheduledDate, targetTime };
  }

  return null;
}

/**
 * Find enabled YAML schedule tasks due at the given time.
 */
export function findDueScheduleTasks(
  tasks: ScheduleTask[],
  now: Date,
  stateStore: ScheduleStateStore
): DueScheduleTask[] {
  return tasks
    .filter((task) => task.enabled !== false)
    .flatMap((task) => {
      const state = stateStore.read(task.name);
      const dueTask = getTaskDueReason(task, now, state);
      return dueTask ? [dueTask] : [];
    });
}

function catchUpSuffix(dueTask: DueScheduleTask): string {
  return dueTask.reason === 'catch-up'
    ? ` (catch-up - missed ${dueTask.targetTime} local window)`
    : '';
}

/**
 * Run YAML-configured tasks that were already determined due.
 */
export async function runDueScheduleTasks(
  dueTasks: DueScheduleTask[],
  options: {
    dryRun?: boolean;
    now: Date;
    stateStore: ScheduleStateStore;
  }
): Promise<void> {
  for (const dueTask of dueTasks) {
    const { task, cronExpr } = dueTask;

    if (options.dryRun) {
      console.log(chalk.yellow(`[DRY RUN] Would run: ${task.name}${catchUpSuffix(dueTask)} (${cronExpr})`));
      continue;
    }

    if (isLocked(task.name)) {
      console.log(chalk.dim(`⏭  ${task.name} — already running, skipping`));
      logger.info({ task: task.name }, 'Skipped — already running');
      continue;
    }

    console.log(chalk.bold(`🐟 Running: ${task.name}${catchUpSuffix(dueTask)}`));
    logger.info(
      {
        task: task.name,
        cron: cronExpr,
        dueReason: dueTask.reason,
        scheduledDate: dueTask.scheduledDate,
        targetTime: dueTask.targetTime,
      },
      'Firing scheduled task'
    );

    if (!acquireLock(task.name)) {
      console.log(chalk.dim(`⏭  ${task.name} — lock contention, skipping`));
      continue;
    }

    try {
      if (dueTask.scheduledDate) {
        options.stateStore.write(task.name, {
          task: task.name,
          lastScheduledDate: dueTask.scheduledDate,
          lastAttemptedAt: localDateTimeKey(options.now),
          reason: dueTask.reason,
        });
      }

      if (INITIATE_TYPES.includes(task.type)) {
        await initiate({
          type: task.type as InitiateTaskType,
          channel: task.channel!,
          context: task.context,
          model: task.model,
        });
      } else {
        await runMaintenanceTask(task);
      }
    } catch (err) {
      logger.error({ task: task.name, error: err }, 'Scheduled task failed');
      console.error(chalk.red(`✗ ${task.name} failed:`), err);
    } finally {
      releaseLock(task.name);
    }
  }
}

/**
 * Run all tasks whose schedule matches the current minute.
 */
export async function scheduleRun(options: ScheduleRunOptions): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  const config = loadSchedule(configPath);
  const now = options.now ?? new Date();

  const activeTasks = config.tasks.filter((t) => t.enabled !== false);
  const stateStore = new FileScheduleStateStore(join(dirname(configPath), '.schedule-state'));
  const dueTasks = findDueScheduleTasks(activeTasks, now, stateStore);

  // Run due YAML-configured tasks
  await runDueScheduleTasks(dueTasks, { dryRun: options.dryRun, now, stateStore });

  // --- Dynamic reminders (from SQLite) ---
  await fireReminders(options.dryRun, now);
}

/**
 * Check and fire any due reminders from the database.
 *
 * Note: initiate() calls closeDb() internally, which kills the singleton
 * connection. We work around this by collecting all due reminders first,
 * closing the DB ourselves, then firing. After all fires complete, we
 * re-open the DB to clean up (delete one-shots, mark recurring as fired).
 */
async function fireReminders(dryRun?: boolean, now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime();

  // Phase 1: Collect due reminders
  const db = await initDb();
  const repo = new SqliteRepo(db);

  const dueResult = await repo.getDueReminders(nowMs);
  const recurringResult = await repo.getRecurringReminders();
  await closeDb();

  // Filter recurring to only those matching now
  const dueOneShots = dueResult.ok ? dueResult.value : [];
  const dueRecurring = recurringResult.ok
    ? recurringResult.value.filter((r) => r.cron && cronMatchesNow(r.cron, now))
    : [];

  if (dueOneShots.length === 0 && dueRecurring.length === 0) return;

  // Phase 2: Fire reminders (each initiate() call opens/closes its own DB)
  const firedOneShotIds: string[] = [];
  const firedRecurringIds: string[] = [];

  for (const reminder of dueOneShots) {
    if (dryRun) {
      console.log(chalk.yellow(`[DRY RUN] Would fire reminder: ${reminder.message}`));
      continue;
    }

    logger.info({ reminderId: reminder.id }, 'Firing one-shot reminder');
    console.log(chalk.bold(`🔔 Firing reminder: ${reminder.message}`));

    try {
      await initiate({
        type: 'heartbeat',
        channel: reminder.channel,
        reminder: reminder.message,
      });
      firedOneShotIds.push(reminder.id);
    } catch (err) {
      logger.error({ reminderId: reminder.id, error: err }, 'Failed to fire reminder');
      console.error(chalk.red(`✗ Reminder failed: ${reminder.message}`), err);
    }
  }

  for (const reminder of dueRecurring) {
    if (dryRun) {
      console.log(chalk.yellow(`[DRY RUN] Would fire recurring reminder: ${reminder.message}`));
      continue;
    }

    logger.info({ reminderId: reminder.id, cron: reminder.cron }, 'Firing recurring reminder');
    console.log(chalk.bold(`🔔 Firing recurring reminder: ${reminder.message}`));

    try {
      await initiate({
        type: 'heartbeat',
        channel: reminder.channel,
        reminder: reminder.message,
      });
      firedRecurringIds.push(reminder.id);
    } catch (err) {
      logger.error({ reminderId: reminder.id, error: err }, 'Failed to fire recurring reminder');
      console.error(chalk.red(`✗ Recurring reminder failed: ${reminder.message}`), err);
    }
  }

  // Phase 3: Clean up — re-open DB, delete one-shots, update recurring
  if (firedOneShotIds.length > 0 || firedRecurringIds.length > 0) {
    const cleanupDb = await initDb();
    const cleanupRepo = new SqliteRepo(cleanupDb);

    for (const id of firedOneShotIds) {
      await cleanupRepo.deleteReminder(id);
    }
    for (const id of firedRecurringIds) {
      await cleanupRepo.markReminderFired(id, nowMs);
    }

    await closeDb();
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
