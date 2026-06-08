import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ScheduleTask } from '../../src/lib/scheduleParser.js';
import type { ScheduleStateStore, ScheduleTaskState } from '../../src/cli/schedule.js';

const workspaceDir = join(tmpdir(), `goldfish-test-schedule-workspace-${crypto.randomUUID()}`);

const mocks = vi.hoisted(() => ({
  initiate: vi.fn(),
  runMaintenanceTask: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  WORKSPACE_PATH: workspaceDir,
}));

vi.mock('../../src/cli/initiate.js', () => ({
  initiate: mocks.initiate,
}));

vi.mock('../../src/cli/maintenance.js', () => ({
  runMaintenanceTask: mocks.runMaintenanceTask,
}));

const {
  FileScheduleStateStore,
  findDueScheduleTasks,
  getTaskDueReason,
  resolveConfigPath,
  runDueScheduleTasks,
} = await import('../../src/cli/schedule.js');

class MemoryScheduleStateStore implements ScheduleStateStore {
  private states = new Map<string, ScheduleTaskState>();

  constructor(initial: Record<string, ScheduleTaskState> = {}) {
    for (const [taskName, state] of Object.entries(initial)) {
      this.states.set(taskName, state);
    }
  }

  read(taskName: string): ScheduleTaskState {
    return this.states.get(taskName) ?? {};
  }

  write(taskName: string, state: ScheduleTaskState): void {
    this.states.set(taskName, state);
  }
}

describe('resolveConfigPath', () => {
  const originalCwd = process.cwd();
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(join(tmpdir(), 'goldfish-test-schedule-cwd-'));
    fs.mkdirSync(workspaceDir, { recursive: true });
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('prefers schedule.yaml in the workspace by default', () => {
    const workspaceSchedule = join(workspaceDir, 'schedule.yaml');
    const cwdSchedule = join(repoDir, 'schedule.yaml');

    fs.writeFileSync(workspaceSchedule, 'tasks: []\n');
    fs.writeFileSync(cwdSchedule, 'tasks: []\n');

    expect(fs.realpathSync(resolveConfigPath())).toBe(fs.realpathSync(workspaceSchedule));
  });

  it('falls back to the current working directory for older setups', () => {
    const cwdSchedule = join(repoDir, 'schedule.yaml');
    fs.writeFileSync(cwdSchedule, 'tasks: []\n');

    expect(fs.realpathSync(resolveConfigPath())).toBe(fs.realpathSync(cwdSchedule));
  });

  it('returns an explicit config path unchanged', () => {
    const explicitPath = join(repoDir, 'custom-schedule.yaml');

    expect(resolveConfigPath(explicitPath)).toBe(explicitPath);
  });

  it('mentions the workspace path in the missing-file error', () => {
    expect(() => resolveConfigPath()).toThrow(
      `Create ${join(workspaceDir, 'schedule.yaml')} or specify --config path.`
    );
  });
});

describe('schedule catch-up task selection', () => {
  const originalCwd = process.cwd();
  let repoDir: string;

  const task: ScheduleTask = {
    name: 'exploration',
    type: 'exploration',
    at: '6pm',
    channel: 'C123',
  };

  beforeEach(() => {
    repoDir = fs.mkdtempSync(join(tmpdir(), 'goldfish-test-schedule-run-cwd-'));
    process.chdir(repoDir);
    mocks.initiate.mockReset();
    mocks.runMaintenanceTask.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('recreates the real 17:59 → 18:01 missed-window regression', async () => {
    const stateStore = new MemoryScheduleStateStore({
      exploration: { lastScheduledDate: '2026-06-04' },
    });

    expect(findDueScheduleTasks(
      [task],
      new Date(2026, 5, 5, 17, 59, 13),
      stateStore
    )).toHaveLength(0);

    const dueAt1801 = findDueScheduleTasks(
      [task],
      new Date(2026, 5, 5, 18, 1, 1),
      stateStore
    );

    expect(dueAt1801).toHaveLength(1);
    expect(dueAt1801[0]).toMatchObject({
      cronExpr: '0 18 * * *',
      reason: 'catch-up',
      scheduledDate: '2026-06-05',
      targetTime: '18:00',
    });

    await runDueScheduleTasks(dueAt1801, {
      now: new Date(2026, 5, 5, 18, 1, 1),
      stateStore,
    });

    expect(mocks.initiate).toHaveBeenCalledTimes(1);
    expect(mocks.initiate).toHaveBeenCalledWith({
      type: 'exploration',
      channel: 'C123',
      context: undefined,
      model: undefined,
    });
    expect(stateStore.read('exploration')).toMatchObject({
      task: 'exploration',
      lastScheduledDate: '2026-06-05',
      reason: 'catch-up',
    });

    expect(findDueScheduleTasks(
      [task],
      new Date(2026, 5, 5, 18, 2, 50),
      stateStore
    )).toHaveLength(0);
  });

  it('dedupes exact at-task runs for the same local date', () => {
    const stateStore = new MemoryScheduleStateStore();
    const dueAtExact = findDueScheduleTasks(
      [task],
      new Date(2026, 5, 5, 18, 0, 35),
      stateStore
    );

    expect(dueAtExact).toHaveLength(1);
    expect(dueAtExact[0]?.reason).toBe('exact');

    stateStore.write('exploration', { lastScheduledDate: '2026-06-05' });

    expect(findDueScheduleTasks(
      [task],
      new Date(2026, 5, 5, 18, 0, 50),
      stateStore
    )).toHaveLength(0);
  });

  it('does not catch up every-interval tasks after a missed exact minute', () => {
    const everyTask: ScheduleTask = {
      name: 'heartbeat',
      type: 'heartbeat',
      every: 'hour',
      between: '8am-10pm',
      channel: 'C123',
    };

    expect(findDueScheduleTasks(
      [everyTask],
      new Date(2026, 5, 5, 18, 1, 1),
      new MemoryScheduleStateStore()
    )).toHaveLength(0);
  });

  it('does not catch up raw cron tasks', () => {
    const rawCronTask: ScheduleTask = {
      ...task,
      cron: '0 18 * * *',
    };

    expect(findDueScheduleTasks(
      [rawCronTask],
      new Date(2026, 5, 5, 18, 1, 1),
      new MemoryScheduleStateStore()
    )).toHaveLength(0);
  });

  it('does not catch up maintenance at tasks', () => {
    const maintenanceTask: ScheduleTask = {
      name: 'daily-synthesis',
      type: 'daily-synthesis',
      at: '1:00am',
    };

    expect(findDueScheduleTasks(
      [maintenanceTask],
      new Date(2026, 5, 5, 11, 30, 0),
      new MemoryScheduleStateStore()
    )).toHaveLength(0);
  });

  it('still runs maintenance at tasks at the exact matching minute', () => {
    const maintenanceTask: ScheduleTask = {
      name: 'daily-synthesis',
      type: 'daily-synthesis',
      at: '1:00am',
    };

    const dueTasks = findDueScheduleTasks(
      [maintenanceTask],
      new Date(2026, 5, 5, 1, 0, 30),
      new MemoryScheduleStateStore()
    );

    expect(dueTasks).toHaveLength(1);
    expect(dueTasks[0]?.reason).toBe('exact');
    expect(dueTasks[0]?.scheduledDate).toBeUndefined();
  });

  it('does not catch up when the days constraint does not match today', () => {
    expect(findDueScheduleTasks(
      [{ ...task, days: 'weekdays' }],
      new Date(2026, 5, 6, 18, 1, 1),
      new MemoryScheduleStateStore()
    )).toHaveLength(0);
  });

  it('does not catch up disabled tasks', () => {
    const stateStore = new MemoryScheduleStateStore();

    expect(findDueScheduleTasks(
      [{ ...task, enabled: false }],
      new Date(2026, 5, 5, 18, 1, 1),
      stateStore
    )).toHaveLength(0);
    expect(stateStore.read('exploration')).toEqual({});
  });

  it('does not backfill multiple missed days after a long sleep', async () => {
    const stateStore = new MemoryScheduleStateStore({
      exploration: { lastScheduledDate: '2026-06-05' },
    });

    const dueAfterWeekAsleep = findDueScheduleTasks(
      [task],
      new Date(2026, 5, 12, 18, 1, 1),
      stateStore
    );

    expect(dueAfterWeekAsleep).toHaveLength(1);
    expect(dueAfterWeekAsleep[0]).toMatchObject({
      reason: 'catch-up',
      scheduledDate: '2026-06-12',
    });

    await runDueScheduleTasks(dueAfterWeekAsleep, {
      now: new Date(2026, 5, 12, 18, 1, 1),
      stateStore,
    });

    expect(mocks.initiate).toHaveBeenCalledTimes(1);
    expect(stateStore.read('exploration')).toMatchObject({
      lastScheduledDate: '2026-06-12',
    });
    expect(findDueScheduleTasks(
      [task],
      new Date(2026, 5, 12, 18, 2, 1),
      stateStore
    )).toHaveLength(0);
  });

  it('does not write state during dry-run', async () => {
    const stateStore = new MemoryScheduleStateStore();
    const dueTasks = findDueScheduleTasks(
      [task],
      new Date(2026, 5, 5, 18, 1, 1),
      stateStore
    );

    await runDueScheduleTasks(dueTasks, {
      dryRun: true,
      now: new Date(2026, 5, 5, 18, 1, 1),
      stateStore,
    });

    expect(mocks.initiate).not.toHaveBeenCalled();
    expect(stateStore.read('exploration')).toEqual({});
  });

  it('stamps an attempted date before a failing task body to prevent retry storms', async () => {
    const stateStore = new MemoryScheduleStateStore();
    mocks.initiate.mockRejectedValueOnce(new Error('boom'));

    const dueTasks = findDueScheduleTasks(
      [task],
      new Date(2026, 5, 5, 18, 1, 1),
      stateStore
    );

    await runDueScheduleTasks(dueTasks, {
      now: new Date(2026, 5, 5, 18, 1, 1),
      stateStore,
    });

    expect(stateStore.read('exploration')).toMatchObject({
      lastScheduledDate: '2026-06-05',
      reason: 'catch-up',
    });
    expect(findDueScheduleTasks(
      [task],
      new Date(2026, 5, 5, 18, 2, 1),
      stateStore
    )).toHaveLength(0);
  });

  it('matches exact raw cron at the exact minute only', () => {
    const rawCronTask: ScheduleTask = {
      ...task,
      cron: '0 18 * * *',
    };

    expect(getTaskDueReason(
      rawCronTask,
      new Date(2026, 5, 5, 18, 0, 35)
    )?.reason).toBe('exact');
    expect(getTaskDueReason(
      rawCronTask,
      new Date(2026, 5, 5, 18, 1, 1)
    )).toBeNull();
  });
});

describe('FileScheduleStateStore', () => {
  it('stores task state with an encoded task-name file key', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'goldfish-test-schedule-state-'));
    const store = new FileScheduleStateStore(join(dir, '.schedule-state'));

    try {
      store.write('task/with spaces', {
        task: 'task/with spaces',
        lastScheduledDate: '2026-06-05',
        reason: 'catch-up',
      });

      expect(store.pathForTask('task/with spaces')).toContain('task%2Fwith%20spaces.last-run.json');
      expect(store.read('task/with spaces')).toMatchObject({
        task: 'task/with spaces',
        lastScheduledDate: '2026-06-05',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
