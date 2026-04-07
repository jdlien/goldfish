import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseTime, toCron, cronMatchesNow, loadSchedule } from '../../src/lib/scheduleParser.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── parseTime ──────────────────────────────────────────────────────────────

describe('parseTime', () => {
  describe('24-hour format', () => {
    it('parses "8:30"', () => {
      expect(parseTime('8:30')).toEqual({ hour: 8, minute: 30 });
    });

    it('parses "18:00"', () => {
      expect(parseTime('18:00')).toEqual({ hour: 18, minute: 0 });
    });

    it('parses "0:00" (midnight)', () => {
      expect(parseTime('0:00')).toEqual({ hour: 0, minute: 0 });
    });

    it('parses "23:59"', () => {
      expect(parseTime('23:59')).toEqual({ hour: 23, minute: 59 });
    });

    it('parses single-digit hour "9:05"', () => {
      expect(parseTime('9:05')).toEqual({ hour: 9, minute: 5 });
    });
  });

  describe('12-hour format — simple (no minutes)', () => {
    it('parses "6pm"', () => {
      expect(parseTime('6pm')).toEqual({ hour: 18, minute: 0 });
    });

    it('parses "6am"', () => {
      expect(parseTime('6am')).toEqual({ hour: 6, minute: 0 });
    });

    it('parses "12pm" (noon)', () => {
      expect(parseTime('12pm')).toEqual({ hour: 12, minute: 0 });
    });

    it('parses "12am" (midnight)', () => {
      expect(parseTime('12am')).toEqual({ hour: 0, minute: 0 });
    });

    it('parses "1am"', () => {
      expect(parseTime('1am')).toEqual({ hour: 1, minute: 0 });
    });

    it('parses "11pm"', () => {
      expect(parseTime('11pm')).toEqual({ hour: 23, minute: 0 });
    });
  });

  describe('12-hour format — with minutes', () => {
    it('parses "8:30am"', () => {
      expect(parseTime('8:30am')).toEqual({ hour: 8, minute: 30 });
    });

    it('parses "8:30pm"', () => {
      expect(parseTime('8:30pm')).toEqual({ hour: 20, minute: 30 });
    });

    it('parses "12:45pm"', () => {
      expect(parseTime('12:45pm')).toEqual({ hour: 12, minute: 45 });
    });

    it('parses "12:01am"', () => {
      expect(parseTime('12:01am')).toEqual({ hour: 0, minute: 1 });
    });
  });

  describe('whitespace and case handling', () => {
    it('handles uppercase "6PM"', () => {
      expect(parseTime('6PM')).toEqual({ hour: 18, minute: 0 });
    });

    it('handles mixed case "6Pm"', () => {
      expect(parseTime('6Pm')).toEqual({ hour: 18, minute: 0 });
    });

    it('handles space before am/pm: "6 pm"', () => {
      expect(parseTime('6 pm')).toEqual({ hour: 18, minute: 0 });
    });

    it('handles space before am/pm with minutes: "8:30 am"', () => {
      expect(parseTime('8:30 am')).toEqual({ hour: 8, minute: 30 });
    });

    it('trims leading/trailing whitespace', () => {
      expect(parseTime('  8:30  ')).toEqual({ hour: 8, minute: 30 });
    });
  });

  describe('error cases', () => {
    it('rejects empty string', () => {
      expect(() => parseTime('')).toThrow('Invalid time format');
    });

    it('rejects words', () => {
      expect(() => parseTime('noon')).toThrow('Invalid time format');
    });

    it('rejects bare number without am/pm', () => {
      expect(() => parseTime('6')).toThrow('Invalid time format');
    });

    it('rejects invalid format "25:00"', () => {
      // Parser doesn't validate range — it just parses. This is intentional;
      // cron will catch nonsense hours. But parsing itself shouldn't crash.
      expect(parseTime('25:00')).toEqual({ hour: 25, minute: 0 });
    });

    it('rejects gibberish', () => {
      expect(() => parseTime('banana')).toThrow('Invalid time format');
    });

    it('rejects time with seconds "8:30:00"', () => {
      expect(() => parseTime('8:30:00')).toThrow('Invalid time format');
    });
  });
});

// ─── toCron ─────────────────────────────────────────────────────────────────

describe('toCron', () => {
  const base = { name: 'test', type: 'morning' as const, channel: 'C123' };

  describe('raw cron passthrough', () => {
    it('passes through a raw cron expression unchanged', () => {
      expect(toCron({ ...base, cron: '0 10-17 * * 1-5' })).toBe('0 10-17 * * 1-5');
    });

    it('raw cron takes priority over at/every/days', () => {
      expect(toCron({ ...base, cron: '*/5 * * * *', at: '9:00', days: 'weekdays' }))
        .toBe('*/5 * * * *');
    });
  });

  describe('at — fixed daily time', () => {
    it('"at: 8:30" → "30 8 * * *"', () => {
      expect(toCron({ ...base, at: '8:30' })).toBe('30 8 * * *');
    });

    it('"at: 6pm" → "0 18 * * *"', () => {
      expect(toCron({ ...base, at: '6pm' })).toBe('0 18 * * *');
    });

    it('"at: 12am" → "0 0 * * *"', () => {
      expect(toCron({ ...base, at: '12am' })).toBe('0 0 * * *');
    });

    it('"at: 8:30am" → "30 8 * * *"', () => {
      expect(toCron({ ...base, at: '8:30am' })).toBe('30 8 * * *');
    });

    it('at + days: weekdays', () => {
      expect(toCron({ ...base, at: '9:00', days: 'weekdays' })).toBe('0 9 * * 1-5');
    });

    it('at + days: weekends', () => {
      expect(toCron({ ...base, at: '10:00', days: 'weekends' })).toBe('0 10 * * 0,6');
    });

    it('at + days: sunday', () => {
      expect(toCron({ ...base, at: '9:00', days: 'sunday' })).toBe('0 9 * * 0');
    });

    it('at + days: comma list "mon,wed,fri"', () => {
      expect(toCron({ ...base, at: '9:00', days: 'mon,wed,fri' })).toBe('0 9 * * 1,3,5');
    });
  });

  describe('every — repeating interval', () => {
    it('"every: hour" → "0 * * * *"', () => {
      expect(toCron({ ...base, every: 'hour' })).toBe('0 * * * *');
    });

    it('"every: 2 hours" → "0 */2 * * *"', () => {
      expect(toCron({ ...base, every: '2 hours' })).toBe('0 */2 * * *');
    });

    it('"every: 4 hours" → "0 */4 * * *"', () => {
      expect(toCron({ ...base, every: '4 hours' })).toBe('0 */4 * * *');
    });

    it('every + days: weekdays', () => {
      expect(toCron({ ...base, every: 'hour', days: 'weekdays' })).toBe('0 * * * 1-5');
    });

    it('"every: 1 hour" is same as "every: hour"', () => {
      expect(toCron({ ...base, every: '1 hour' })).toBe('0 * * * *');
    });
  });

  describe('every + between — windowed interval', () => {
    it('"every: hour, between: 10am-5pm" → "0 10-17 * * *"', () => {
      expect(toCron({ ...base, every: 'hour', between: '10am-5pm' })).toBe('0 10-17 * * *');
    });

    it('"every: hour, between: 10:00-17:00" → "0 10-17 * * *"', () => {
      expect(toCron({ ...base, every: 'hour', between: '10:00-17:00' })).toBe('0 10-17 * * *');
    });

    it('"every: 2 hours, between: 8am-6pm" → "0 8,10,12,14,16,18 * * *"', () => {
      expect(toCron({ ...base, every: '2 hours', between: '8am-6pm' })).toBe('0 8,10,12,14,16,18 * * *');
    });

    it('"every: 4 hours, between: 8am-8pm" → "0 8,12,16,20 * * *"', () => {
      expect(toCron({ ...base, every: '4 hours', between: '8am-8pm' })).toBe('0 8,12,16,20 * * *');
    });

    it('every + between + days', () => {
      expect(toCron({ ...base, every: 'hour', between: '9am-5pm', days: 'weekdays' }))
        .toBe('0 9-17 * * 1-5');
    });

    it('between with minutes: "9:30am-4:30pm" uses start minute', () => {
      expect(toCron({ ...base, every: 'hour', between: '9:30am-4:30pm' }))
        .toBe('30 9-16 * * *');
    });
  });

  describe('days — all variations', () => {
    it('daily (explicit)', () => {
      expect(toCron({ ...base, at: '9:00', days: 'daily' })).toBe('0 9 * * *');
    });

    it('monday', () => {
      expect(toCron({ ...base, at: '9:00', days: 'monday' })).toBe('0 9 * * 1');
    });

    it('tue', () => {
      expect(toCron({ ...base, at: '9:00', days: 'tue' })).toBe('0 9 * * 2');
    });

    it('wednesday', () => {
      expect(toCron({ ...base, at: '9:00', days: 'wednesday' })).toBe('0 9 * * 3');
    });

    it('thu', () => {
      expect(toCron({ ...base, at: '9:00', days: 'thu' })).toBe('0 9 * * 4');
    });

    it('friday', () => {
      expect(toCron({ ...base, at: '9:00', days: 'friday' })).toBe('0 9 * * 5');
    });

    it('sat', () => {
      expect(toCron({ ...base, at: '9:00', days: 'sat' })).toBe('0 9 * * 6');
    });

    it('sun', () => {
      expect(toCron({ ...base, at: '9:00', days: 'sun' })).toBe('0 9 * * 0');
    });

    it('mixed comma list "tue,thu,sat"', () => {
      expect(toCron({ ...base, at: '9:00', days: 'tue,thu,sat' })).toBe('0 9 * * 2,4,6');
    });
  });

  describe('error cases', () => {
    it('throws when no timing fields are provided', () => {
      expect(() => toCron({ ...base })).toThrow('needs either "at", "every", or "cron"');
    });

    it('throws on invalid day name', () => {
      expect(() => toCron({ ...base, at: '9:00', days: 'funday' })).toThrow('Unknown day');
    });

    it('throws on invalid every format', () => {
      expect(() => toCron({ ...base, every: '30 minutes' })).toThrow('Invalid interval');
    });

    it('throws on invalid every format (words)', () => {
      expect(() => toCron({ ...base, every: 'sometimes' })).toThrow('Invalid interval');
    });

    it('throws on invalid time in at', () => {
      expect(() => toCron({ ...base, at: 'noon' })).toThrow('Invalid time format');
    });
  });
});

// ─── cronMatchesNow ─────────────────────────────────────────────────────────

describe('cronMatchesNow', () => {
  // Helper: create a Date for a specific day/time
  // month is 0-indexed, day of week is derived from the date
  function makeDate(year: number, month: number, day: number, hour: number, minute: number): Date {
    return new Date(year, month, day, hour, minute, 0);
  }

  describe('exact time matching', () => {
    it('matches "30 8 * * *" at 8:30', () => {
      const date = makeDate(2026, 3, 6, 8, 30); // Apr 6, 2026
      expect(cronMatchesNow('30 8 * * *', date)).toBe(true);
    });

    it('does not match "30 8 * * *" at 8:31', () => {
      const date = makeDate(2026, 3, 6, 8, 31);
      expect(cronMatchesNow('30 8 * * *', date)).toBe(false);
    });

    it('does not match "30 8 * * *" at 9:30', () => {
      const date = makeDate(2026, 3, 6, 9, 30);
      expect(cronMatchesNow('30 8 * * *', date)).toBe(false);
    });

    it('matches "0 0 * * *" at midnight', () => {
      const date = makeDate(2026, 3, 6, 0, 0);
      expect(cronMatchesNow('0 0 * * *', date)).toBe(true);
    });
  });

  describe('wildcard fields', () => {
    it('"0 * * * *" matches any hour at minute 0', () => {
      expect(cronMatchesNow('0 * * * *', makeDate(2026, 3, 6, 14, 0))).toBe(true);
      expect(cronMatchesNow('0 * * * *', makeDate(2026, 3, 6, 0, 0))).toBe(true);
      expect(cronMatchesNow('0 * * * *', makeDate(2026, 3, 6, 23, 0))).toBe(true);
    });

    it('"0 * * * *" does not match minute 30', () => {
      expect(cronMatchesNow('0 * * * *', makeDate(2026, 3, 6, 14, 30))).toBe(false);
    });
  });

  describe('range matching', () => {
    it('"0 10-17 * * *" matches hours 10 through 17', () => {
      expect(cronMatchesNow('0 10-17 * * *', makeDate(2026, 3, 6, 10, 0))).toBe(true);
      expect(cronMatchesNow('0 10-17 * * *', makeDate(2026, 3, 6, 13, 0))).toBe(true);
      expect(cronMatchesNow('0 10-17 * * *', makeDate(2026, 3, 6, 17, 0))).toBe(true);
    });

    it('"0 10-17 * * *" does not match hour 9 or 18', () => {
      expect(cronMatchesNow('0 10-17 * * *', makeDate(2026, 3, 6, 9, 0))).toBe(false);
      expect(cronMatchesNow('0 10-17 * * *', makeDate(2026, 3, 6, 18, 0))).toBe(false);
    });
  });

  describe('comma list matching', () => {
    it('"0 8,12,16 * * *" matches listed hours', () => {
      expect(cronMatchesNow('0 8,12,16 * * *', makeDate(2026, 3, 6, 8, 0))).toBe(true);
      expect(cronMatchesNow('0 8,12,16 * * *', makeDate(2026, 3, 6, 12, 0))).toBe(true);
      expect(cronMatchesNow('0 8,12,16 * * *', makeDate(2026, 3, 6, 16, 0))).toBe(true);
    });

    it('"0 8,12,16 * * *" does not match unlisted hours', () => {
      expect(cronMatchesNow('0 8,12,16 * * *', makeDate(2026, 3, 6, 10, 0))).toBe(false);
      expect(cronMatchesNow('0 8,12,16 * * *', makeDate(2026, 3, 6, 14, 0))).toBe(false);
    });
  });

  describe('step matching', () => {
    it('"0 */2 * * *" matches even hours', () => {
      expect(cronMatchesNow('0 */2 * * *', makeDate(2026, 3, 6, 0, 0))).toBe(true);
      expect(cronMatchesNow('0 */2 * * *', makeDate(2026, 3, 6, 4, 0))).toBe(true);
      expect(cronMatchesNow('0 */2 * * *', makeDate(2026, 3, 6, 22, 0))).toBe(true);
    });

    it('"0 */2 * * *" does not match odd hours', () => {
      expect(cronMatchesNow('0 */2 * * *', makeDate(2026, 3, 6, 1, 0))).toBe(false);
      expect(cronMatchesNow('0 */2 * * *', makeDate(2026, 3, 6, 15, 0))).toBe(false);
    });
  });

  describe('day-of-week matching', () => {
    // Apr 6, 2026 is a Monday (day 1)
    it('"0 9 * * 1-5" matches Monday (weekday)', () => {
      expect(cronMatchesNow('0 9 * * 1-5', makeDate(2026, 3, 6, 9, 0))).toBe(true);
    });

    // Apr 5, 2026 is a Sunday (day 0)
    it('"0 9 * * 1-5" does not match Sunday', () => {
      expect(cronMatchesNow('0 9 * * 1-5', makeDate(2026, 3, 5, 9, 0))).toBe(false);
    });

    // Apr 11, 2026 is a Saturday (day 6)
    it('"0 9 * * 0,6" matches Saturday (weekend)', () => {
      expect(cronMatchesNow('0 9 * * 0,6', makeDate(2026, 3, 11, 9, 0))).toBe(true);
    });

    it('"0 9 * * 0,6" does not match Wednesday', () => {
      // Apr 8, 2026 is a Wednesday
      expect(cronMatchesNow('0 9 * * 0,6', makeDate(2026, 3, 8, 9, 0))).toBe(false);
    });

    it('"0 9 * * 0" matches Sunday only', () => {
      expect(cronMatchesNow('0 9 * * 0', makeDate(2026, 3, 5, 9, 0))).toBe(true);
      expect(cronMatchesNow('0 9 * * 0', makeDate(2026, 3, 6, 9, 0))).toBe(false);
    });
  });

  describe('combined field matching', () => {
    it('"0 10-17 * * 1-5" — weekday work hours', () => {
      // Monday 10am — should match
      expect(cronMatchesNow('0 10-17 * * 1-5', makeDate(2026, 3, 6, 10, 0))).toBe(true);
      // Sunday 10am — should not match
      expect(cronMatchesNow('0 10-17 * * 1-5', makeDate(2026, 3, 5, 10, 0))).toBe(false);
      // Monday 9am — should not match (too early)
      expect(cronMatchesNow('0 10-17 * * 1-5', makeDate(2026, 3, 6, 9, 0))).toBe(false);
    });
  });
});

// ─── loadSchedule ───────────────────────────────────────────────────────────

describe('loadSchedule', () => {
  let tmpDir: string;

  function writeYaml(filename: string, content: string): string {
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'goldfish-schedule-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid schedule file', () => {
    const path = writeYaml('schedule.yaml', `
tasks:
  - name: morning
    type: morning
    at: "8:30am"
    channel: C123
  - name: heartbeat
    type: heartbeat
    every: hour
    between: "10am-5pm"
    days: weekdays
    channel: C123
`);
    const config = loadSchedule(path);
    expect(config.tasks).toHaveLength(2);
    expect(config.tasks[0].name).toBe('morning');
    expect(config.tasks[1].name).toBe('heartbeat');
  });

  it('validates that tasks is an array', () => {
    const path = writeYaml('bad.yaml', 'tasks: "not an array"');
    expect(() => loadSchedule(path)).toThrow('expected "tasks" array');
  });

  it('validates missing top-level tasks key', () => {
    const path = writeYaml('bad.yaml', 'schedule:\n  - name: foo');
    expect(() => loadSchedule(path)).toThrow('expected "tasks" array');
  });

  it('defaults name to type when omitted', () => {
    const path = writeYaml('ok.yaml', `
tasks:
  - type: morning
    at: "8:30"
    channel: C123
`);
    const config = loadSchedule(path);
    expect(config.tasks[0].name).toBe('morning');
  });

  it('rejects task with no type', () => {
    const path = writeYaml('bad.yaml', `
tasks:
  - name: test
    at: "8:30"
    channel: C123
`);
    expect(() => loadSchedule(path)).toThrow('needs a "type"');
  });

  it('rejects initiate task with no channel', () => {
    const path = writeYaml('bad.yaml', `
tasks:
  - name: test
    type: morning
    at: "8:30"
`);
    expect(() => loadSchedule(path)).toThrow('needs a "channel"');
  });

  it('accepts maintenance task without channel', () => {
    const path = writeYaml('ok.yaml', `
tasks:
  - name: nightly-index
    type: index-memory
    at: "1:15am"
`);
    const config = loadSchedule(path);
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].type).toBe('index-memory');
  });

  it('rejects task with no timing fields', () => {
    const path = writeYaml('bad.yaml', `
tasks:
  - name: test
    type: morning
    channel: C123
`);
    expect(() => loadSchedule(path)).toThrow('needs either "at", "every", or "cron"');
  });

  it('rejects task with invalid time', () => {
    const path = writeYaml('bad.yaml', `
tasks:
  - name: test
    type: morning
    at: "never"
    channel: C123
`);
    expect(() => loadSchedule(path)).toThrow('Invalid time format');
  });

  it('preserves optional fields (context, enabled)', () => {
    const path = writeYaml('schedule.yaml', `
tasks:
  - name: morning
    type: morning
    at: "8:30"
    channel: C123
    context: "Focus on TPL today"
    enabled: false
`);
    const config = loadSchedule(path);
    expect(config.tasks[0].context).toBe('Focus on TPL today');
    expect(config.tasks[0].enabled).toBe(false);
  });

  it('throws on nonexistent file', () => {
    expect(() => loadSchedule('/nonexistent/path.yaml')).toThrow();
  });

  it('handles empty tasks array', () => {
    const path = writeYaml('empty.yaml', 'tasks: []');
    const config = loadSchedule(path);
    expect(config.tasks).toHaveLength(0);
  });

  it('accepts raw cron alongside human-readable tasks', () => {
    const path = writeYaml('schedule.yaml', `
tasks:
  - name: morning
    type: morning
    at: "8:30am"
    channel: C123
  - name: custom
    type: heartbeat
    cron: "*/15 9-17 * * 1-5"
    channel: C456
`);
    const config = loadSchedule(path);
    expect(config.tasks).toHaveLength(2);
  });
});

// ─── Integration: toCron → cronMatchesNow round-trip ────────────────────────

describe('round-trip: toCron → cronMatchesNow', () => {
  const base = { name: 'test', type: 'morning' as const, channel: 'C123' };

  it('"at: 8:30, days: weekdays" matches Mon 8:30, not Mon 9:00', () => {
    const cron = toCron({ ...base, at: '8:30', days: 'weekdays' });
    // Monday Apr 6, 2026
    expect(cronMatchesNow(cron, new Date(2026, 3, 6, 8, 30))).toBe(true);
    expect(cronMatchesNow(cron, new Date(2026, 3, 6, 9, 0))).toBe(false);
  });

  it('"every: hour, between: 10am-5pm, days: weekdays" matches Mon 12:00, not Sat 12:00', () => {
    const cron = toCron({ ...base, every: 'hour', between: '10am-5pm', days: 'weekdays' });
    // Monday
    expect(cronMatchesNow(cron, new Date(2026, 3, 6, 12, 0))).toBe(true);
    // Saturday
    expect(cronMatchesNow(cron, new Date(2026, 3, 11, 12, 0))).toBe(false);
  });

  it('"at: 6pm" matches any day at 18:00', () => {
    const cron = toCron({ ...base, at: '6pm' });
    expect(cronMatchesNow(cron, new Date(2026, 3, 6, 18, 0))).toBe(true);
    expect(cronMatchesNow(cron, new Date(2026, 3, 11, 18, 0))).toBe(true);
    expect(cronMatchesNow(cron, new Date(2026, 3, 6, 17, 0))).toBe(false);
  });

  it('"at: 9:00, days: sunday" matches Sun 9:00 only', () => {
    const cron = toCron({ ...base, at: '9:00', days: 'sunday' });
    // Sunday Apr 5, 2026
    expect(cronMatchesNow(cron, new Date(2026, 3, 5, 9, 0))).toBe(true);
    // Monday Apr 6, 2026
    expect(cronMatchesNow(cron, new Date(2026, 3, 6, 9, 0))).toBe(false);
  });
});
