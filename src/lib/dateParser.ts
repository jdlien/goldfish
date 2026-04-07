/**
 * Date Parser for Reminders
 *
 * Parses human-readable date/time expressions into absolute timestamps.
 *
 * Supported formats:
 *   "noon"                    → today at 12:00 (or tomorrow if past)
 *   "noon tomorrow"           → tomorrow at 12:00
 *   "5pm friday"              → next Friday at 5:00 PM
 *   "tomorrow 9am"            → tomorrow at 9:00 AM
 *   "in 2 hours"              → 2 hours from now
 *   "in 30 minutes"           → 30 minutes from now
 *   "2026-04-07 14:00"        → absolute date/time
 *   "3pm"                     → today at 3:00 PM (or tomorrow if past)
 *   "monday 8:30am"           → next Monday at 8:30 AM
 */

import { parseTime } from './scheduleParser.js';

const DAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const NAMED_TIMES: Record<string, { hour: number; minute: number }> = {
  noon: { hour: 12, minute: 0 },
  midnight: { hour: 0, minute: 0 },
  morning: { hour: 9, minute: 0 },
  evening: { hour: 18, minute: 0 },
};

/**
 * Parse a relative/absolute date expression into a Unix ms timestamp.
 * Throws if the expression can't be parsed.
 */
export function parseDateExpression(input: string, now: Date = new Date()): number {
  const normalized = input.trim().toLowerCase();

  // "in N hours/minutes"
  const relativeMatch = normalized.match(/^in\s+(\d+)\s+(hours?|minutes?|mins?)$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const ms = unit.startsWith('hour') ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
    return now.getTime() + ms;
  }

  // Absolute ISO-ish: "2026-04-07 14:00" or "2026-04-07T14:00"
  const isoMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{1,2}:\d{2}(?:am|pm)?)$/);
  if (isoMatch) {
    const [, datePart, timePart] = isoMatch;
    const { hour, minute } = parseTime(timePart);
    const [year, month, day] = datePart.split('-').map(Number);
    const target = new Date(year, month - 1, day, hour, minute, 0, 0);
    return target.getTime();
  }

  // Absolute date only: "2026-04-07" → that day at 9am
  const dateOnlyMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnlyMatch) {
    const [year, month, day] = dateOnlyMatch[1].split('-').map(Number);
    const target = new Date(year, month - 1, day, 9, 0, 0, 0);
    return target.getTime();
  }

  // Split into tokens and identify components
  const tokens = normalized.split(/\s+/);

  let dayOffset: number | null = null; // days from today
  let dayOfWeek: number | null = null; // 0-6
  let time: { hour: number; minute: number } | null = null;

  for (const token of tokens) {
    // Named day keywords
    if (token === 'today') {
      dayOffset = 0;
      continue;
    }
    if (token === 'tomorrow') {
      dayOffset = 1;
      continue;
    }

    // Named times
    if (NAMED_TIMES[token]) {
      time = NAMED_TIMES[token];
      continue;
    }

    // Day of week
    if (DAY_NAMES[token] !== undefined) {
      dayOfWeek = DAY_NAMES[token];
      continue;
    }

    // Time expression (delegate to scheduleParser's parseTime)
    try {
      time = parseTime(token);
      continue;
    } catch {
      // Not a time — ignore
    }
  }

  // If we got nothing useful, bail
  if (time === null && dayOffset === null && dayOfWeek === null) {
    throw new Error(
      `Can't parse date expression: "${input}". ` +
      'Try: "noon tomorrow", "5pm friday", "in 2 hours", or "2026-04-07 14:00".'
    );
  }

  // Default time if only a day was specified
  if (time === null) {
    time = { hour: 9, minute: 0 };
  }

  // Resolve the target date
  let target: Date;

  if (dayOffset !== null) {
    target = new Date(now);
    target.setDate(target.getDate() + dayOffset);
  } else if (dayOfWeek !== null) {
    target = nextDayOfWeek(now, dayOfWeek);
  } else {
    // Just a time — use today, bump to tomorrow if already past
    target = new Date(now);
  }

  target.setHours(time.hour, time.minute, 0, 0);

  // If the resolved time is in the past and no explicit day was given, bump to tomorrow
  if (target.getTime() <= now.getTime() && dayOffset === null && dayOfWeek === null) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime();
}

/**
 * Get the next occurrence of a day of week (0=Sun, 6=Sat).
 * If today is that day, returns next week.
 */
function nextDayOfWeek(now: Date, targetDay: number): Date {
  const current = now.getDay();
  let daysAhead = targetDay - current;
  if (daysAhead <= 0) daysAhead += 7; // Always next occurrence
  const result = new Date(now);
  result.setDate(result.getDate() + daysAhead);
  return result;
}

/**
 * Format a timestamp for human display.
 */
export function formatFireTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  if (d.toDateString() === now.toDateString()) {
    return `today at ${timeStr}`;
  }
  if (d.toDateString() === tomorrow.toDateString()) {
    return `tomorrow at ${timeStr}`;
  }

  const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dayName} ${dateStr} at ${timeStr}`;
}
