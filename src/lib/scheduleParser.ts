/**
 * Schedule Parser
 *
 * Converts human-readable schedule syntax to cron expressions.
 *
 * Supported fields:
 *   at: "8:30" | "8:30am" | "6pm" | "18:00"    — time of day
 *   every: "hour" | "2 hours" | "4 hours"       — repeating interval
 *   between: "10am-5pm" | "10:00-17:00"         — constrains `every`
 *   days: "daily" | "weekdays" | "weekends" | "monday" | "mon,wed,fri"
 *   cron: "0 10-17 * * 1-5"                     — raw cron (overrides all above)
 */

import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'fs';

export type InitiateTaskType = 'morning' | 'weekly' | 'exploration' | 'heartbeat';
export type MaintenanceTaskType = 'daily-synthesis' | 'index-memory' | 'thread-synthesis';
export type TaskType = InitiateTaskType | MaintenanceTaskType;

export const INITIATE_TYPES: readonly string[] = ['morning', 'weekly', 'exploration', 'heartbeat'];
export const MAINTENANCE_TYPES: readonly string[] = ['daily-synthesis', 'index-memory', 'thread-synthesis'];

export interface ScheduleTask {
  /** Task name — defaults to type if omitted */
  name: string;
  type: TaskType;
  /** Slack channel — required for initiate tasks, ignored for maintenance tasks */
  channel?: string;
  /** Time of day: "8:30", "8:30am", "6pm", "18:00" */
  at?: string;
  /** Repeating interval: "hour", "2 hours", "4 hours" */
  every?: string;
  /** Window for `every`: "10am-5pm", "10:00-17:00" */
  between?: string;
  /** Days: "daily", "weekdays", "weekends", "monday", "mon,wed,fri" */
  days?: string;
  /** Raw cron expression — overrides all other timing fields */
  cron?: string;
  /** Extra context passed to the prompt */
  context?: string;
  /** Whether this task is active (default: true) */
  enabled?: boolean;
  /** Model override for this task (e.g. "claude-opus-4-6", "claude-sonnet-4-6") */
  model?: string;
}

export interface ScheduleConfig {
  tasks: ScheduleTask[];
}

const DAY_MAP: Record<string, string> = {
  daily: '*',
  weekdays: '1-5',
  weekends: '0,6',
  sunday: '0', sun: '0',
  monday: '1', mon: '1',
  tuesday: '2', tue: '2',
  wednesday: '3', wed: '3',
  thursday: '4', thu: '4',
  friday: '5', fri: '5',
  saturday: '6', sat: '6',
};

/**
 * Parse a time string like "8:30", "8:30am", "6pm", "18:00" into { hour, minute }
 */
export function parseTime(time: string): { hour: number; minute: number } {
  const normalized = time.trim().toLowerCase();

  // Match "6pm", "6am", "12pm"
  const simpleMatch = normalized.match(/^(\d{1,2})\s*(am|pm)$/);
  if (simpleMatch) {
    let hour = parseInt(simpleMatch[1], 10);
    const period = simpleMatch[2];
    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
    return { hour, minute: 0 };
  }

  // Match "8:30am", "8:30pm", "12:45pm"
  const fullMatch = normalized.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (fullMatch) {
    let hour = parseInt(fullMatch[1], 10);
    const minute = parseInt(fullMatch[2], 10);
    const period = fullMatch[3];
    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  // Match "18:00", "8:30" (24-hour)
  const militaryMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (militaryMatch) {
    return {
      hour: parseInt(militaryMatch[1], 10),
      minute: parseInt(militaryMatch[2], 10),
    };
  }

  throw new Error(`Invalid time format: "${time}". Use "8:30", "8:30am", "6pm", or "18:00".`);
}

/**
 * Parse an interval string like "hour", "2 hours", "4 hours"
 */
function parseInterval(every: string): number {
  const normalized = every.trim().toLowerCase();
  if (normalized === 'hour') return 1;

  const match = normalized.match(/^(\d+)\s*hours?$/);
  if (match) return parseInt(match[1], 10);

  throw new Error(`Invalid interval: "${every}". Use "hour", "2 hours", "4 hours", etc.`);
}

/**
 * Parse a days string into a cron day-of-week field.
 * Supports: "daily", "weekdays", "weekends", "monday", "mon,wed,fri"
 */
function parseDays(days: string): string {
  const normalized = days.trim().toLowerCase();

  // Direct lookup
  if (DAY_MAP[normalized] !== undefined) return DAY_MAP[normalized];

  // Comma-separated list: "mon,wed,fri"
  const parts = normalized.split(/\s*,\s*/);
  const mapped = parts.map((part) => {
    if (DAY_MAP[part] === undefined) {
      throw new Error(`Unknown day: "${part}". Use: daily, weekdays, weekends, monday-sunday, or mon-sun.`);
    }
    return DAY_MAP[part];
  });

  return mapped.join(',');
}

/**
 * Convert a human-readable schedule task to a cron expression.
 */
export function toCron(task: ScheduleTask): string {
  // Raw cron takes priority
  if (task.cron) return task.cron;

  const dayField = task.days ? parseDays(task.days) : '*';

  // Fixed time: at
  if (task.at) {
    const { hour, minute } = parseTime(task.at);
    return `${minute} ${hour} * * ${dayField}`;
  }

  // Repeating interval: every (optionally with between)
  if (task.every) {
    const intervalHours = parseInterval(task.every);

    if (task.between) {
      const [startStr, endStr] = task.between.split('-').map((s) => s.trim());
      const start = parseTime(startStr);
      const end = parseTime(endStr);

      if (intervalHours === 1) {
        return `${start.minute} ${start.hour}-${end.hour} * * ${dayField}`;
      }

      // For multi-hour intervals within a window, enumerate the hours
      const hours: number[] = [];
      for (let h = start.hour; h <= end.hour; h += intervalHours) {
        hours.push(h);
      }
      return `${start.minute} ${hours.join(',')} * * ${dayField}`;
    }

    // No window — every N hours all day
    if (intervalHours === 1) {
      return `0 * * * ${dayField}`;
    }
    return `0 */${intervalHours} * * ${dayField}`;
  }

  throw new Error(
    `Task "${task.name}" needs either "at", "every", or "cron" to define when it runs.`
  );
}

/**
 * Load and parse schedule.yaml from the given path.
 */
export function loadSchedule(path: string): ScheduleConfig {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as ScheduleConfig;

  if (!parsed?.tasks || !Array.isArray(parsed.tasks)) {
    throw new Error(`Invalid schedule file: expected "tasks" array in ${path}`);
  }

  // Validate and normalize each task
  for (const task of parsed.tasks) {
    if (!task.type) throw new Error(`Task "${task.name || '(unnamed)'}" needs a "type".`);
    if (!task.name) task.name = task.type;
    if (INITIATE_TYPES.includes(task.type) && !task.channel && !process.env.GOLDFISH_DM_CHANNEL_ID) {
      throw new Error(`Task "${task.name}" (type: ${task.type}) needs a "channel" (or set GOLDFISH_DM_CHANNEL_ID in .env).`);
    }
    // Validate that the cron expression can be generated
    toCron(task);
  }

  return parsed;
}

/**
 * Check if a cron expression matches the given date (to the minute).
 */
export function cronMatchesNow(cronExpr: string, now: Date): boolean {
  const [minuteField, hourField, _domField, _monthField, dowField] = cronExpr.split(' ');

  const minute = now.getMinutes();
  const hour = now.getHours();
  const dow = now.getDay();

  return (
    fieldMatches(minuteField, minute, 0, 59) &&
    fieldMatches(hourField, hour, 0, 23) &&
    fieldMatches(dowField, dow, 0, 6)
  );
}

/**
 * Check if a single cron field matches a value.
 * Supports: *, N, N-M, N,M,O, *\/N, N-M with step
 */
function fieldMatches(field: string, value: number, _min: number, _max: number): boolean {
  // Wildcard
  if (field === '*') return true;

  // Comma-separated list (handle first since items can be ranges)
  if (field.includes(',')) {
    return field.split(',').some((part) => fieldMatches(part.trim(), value, _min, _max));
  }

  // Step: */N or N-M/S (only */N for now)
  if (field.includes('/')) {
    const [range, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (range === '*') {
      return value % step === 0;
    }
    // Range with step: e.g., 10-17/2
    if (range.includes('-')) {
      const [start, end] = range.split('-').map(Number);
      return value >= start && value <= end && (value - start) % step === 0;
    }
  }

  // Range: N-M
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(Number);
    return value >= start && value <= end;
  }

  // Exact value
  return parseInt(field, 10) === value;
}
