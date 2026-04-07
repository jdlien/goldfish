/**
 * Remind Command
 *
 * Create, list, and delete reminders that fire via Slack.
 *
 * Usage:
 *   goldfish remind "Check the deploy" --at "5pm"
 *   goldfish remind "Prep for standup" --at "9am" --recurring --days weekdays
 *   goldfish remind list
 *   goldfish remind delete <id>
 */

import chalk from 'chalk';
import { initDb, closeDb } from '../db/index.js';
import { SqliteRepo } from '../adapters/SqliteRepo.js';
import { parseDateExpression, formatFireTime } from '../lib/dateParser.js';
import { toCron, type ScheduleTask } from '../lib/scheduleParser.js';
import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('cli:remind');

export interface RemindCreateOptions {
  message: string;
  at?: string;
  channel?: string;
  recurring?: boolean;
  days?: string;
  context?: string;
}

export interface RemindDeleteOptions {
  id: string;
}

/**
 * Create a new reminder.
 */
export async function remindCreate(options: RemindCreateOptions): Promise<void> {
  const channel = options.channel || process.env.GOLDFISH_DM_CHANNEL_ID;
  if (!channel) {
    console.error(chalk.red('Error: No channel specified.'));
    console.log(chalk.dim('Set GOLDFISH_DM_CHANNEL_ID in .env or use --channel'));
    process.exit(1);
  }

  if (!options.at) {
    console.error(chalk.red('Error: --at is required. Try: "noon tomorrow", "5pm friday", "in 2 hours"'));
    process.exit(1);
  }

  const db = await initDb();
  const repo = new SqliteRepo(db);

  try {
    if (options.recurring) {
      // Build a cron expression from --at and --days
      const task: ScheduleTask = {
        name: 'reminder',
        type: 'heartbeat', // doesn't matter, just need toCron
        at: options.at,
        days: options.days || 'daily',
      };

      let cronExpr: string;
      try {
        cronExpr = toCron(task);
      } catch (err) {
        console.error(chalk.red(`Error: Invalid schedule — ${(err as Error).message}`));
        process.exit(1);
      }

      const result = await repo.createReminder({
        channel,
        message: options.message,
        cron: cronExpr,
        recurring: true,
        context: options.context,
      });

      if (!result.ok) {
        console.error(chalk.red(`Error: ${result.error.message}`));
        process.exit(1);
      }

      console.log(chalk.green('✓ Recurring reminder created'));
      console.log(`  ${chalk.bold('ID:')} ${result.value.id}`);
      console.log(`  ${chalk.bold('Message:')} ${options.message}`);
      console.log(`  ${chalk.bold('Schedule:')} ${options.at} ${options.days || 'daily'} (${cronExpr})`);
    } else {
      // One-shot: parse the date expression
      let fireAt: number;
      try {
        fireAt = parseDateExpression(options.at);
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }

      const result = await repo.createReminder({
        channel,
        message: options.message,
        fireAt,
        recurring: false,
        context: options.context,
      });

      if (!result.ok) {
        console.error(chalk.red(`Error: ${result.error.message}`));
        process.exit(1);
      }

      console.log(chalk.green('✓ Reminder set'));
      console.log(`  ${chalk.bold('ID:')} ${result.value.id}`);
      console.log(`  ${chalk.bold('Message:')} ${options.message}`);
      console.log(`  ${chalk.bold('Fires:')} ${formatFireTime(fireAt)}`);
    }
  } finally {
    await closeDb();
  }
}

/**
 * List all reminders.
 */
export async function remindList(): Promise<void> {
  const db = await initDb();
  const repo = new SqliteRepo(db);

  try {
    const result = await repo.listReminders();
    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error.message}`));
      process.exit(1);
    }

    const reminders = result.value;
    if (reminders.length === 0) {
      console.log(chalk.dim('No reminders set.'));
      return;
    }

    console.log(chalk.bold(`\n🔔 Reminders (${reminders.length})\n`));

    for (const r of reminders) {
      const type = r.recurring ? chalk.cyan('recurring') : chalk.yellow('one-shot');
      const schedule = r.recurring
        ? `cron: ${r.cron}`
        : r.fire_at
          ? formatFireTime(r.fire_at)
          : 'no schedule';
      const id = chalk.dim(r.id.slice(0, 8));

      console.log(`  ${type} ${id}  ${chalk.bold(r.message)}`);
      console.log(`         ${chalk.dim(schedule)}`);
    }

    console.log();
  } finally {
    await closeDb();
  }
}

/**
 * Delete a reminder by ID (prefix match).
 */
export async function remindDelete(options: RemindDeleteOptions): Promise<void> {
  const db = await initDb();
  const repo = new SqliteRepo(db);

  try {
    // Support prefix matching for convenience
    const allResult = await repo.listReminders();
    if (!allResult.ok) {
      console.error(chalk.red(`Error: ${allResult.error.message}`));
      process.exit(1);
    }

    const match = allResult.value.find((r) => r.id.startsWith(options.id));
    if (!match) {
      console.error(chalk.red(`No reminder found matching "${options.id}"`));
      process.exit(1);
    }

    const result = await repo.deleteReminder(match.id);
    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error.message}`));
      process.exit(1);
    }

    console.log(chalk.green(`✓ Deleted reminder: ${match.message}`));
  } finally {
    await closeDb();
  }
}
