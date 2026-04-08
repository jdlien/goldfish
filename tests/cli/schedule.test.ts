import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const workspaceDir = join(tmpdir(), `goldfish-test-schedule-workspace-${crypto.randomUUID()}`);

vi.mock('../../src/config.js', () => ({
  WORKSPACE_PATH: workspaceDir,
}));

const { resolveConfigPath } = await import('../../src/cli/schedule.js');

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
