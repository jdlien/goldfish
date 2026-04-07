import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = join(tmpdir(), `goldfish-test-initiate-${crypto.randomUUID()}`);

vi.mock('../../src/config.js', () => ({
  WORKSPACE_PATH: testDir,
  SESSIONS_PATH: join(testDir, 'memory', 'sessions'),
  SEARCH_DB_PATH: join(testDir, 'search.sqlite'),
  DEFAULT_MAX_TURNS: 50,
  DEFAULT_TIMEOUT_MS: 300000,
  SESSION_EXPIRY_MS: 86400000,
  validateWorkspace: () => null,
}));

const { buildPrompt } = await import('../../src/cli/initiate.js');

beforeEach(() => {
  fs.mkdirSync(join(testDir, 'prompts'), { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe('buildPrompt', () => {
  it('builds morning check-in from default when no workspace prompt exists', () => {
    const prompt = buildPrompt({ type: 'morning' });
    expect(prompt).toContain('Morning Check-in');
    expect(prompt).toContain('FOCUS.md');
    expect(prompt).toContain('CLAUDE.md');
  });

  it('builds weekly review from default', () => {
    const prompt = buildPrompt({ type: 'weekly' });
    expect(prompt).toContain('Weekly Review');
  });

  it('loads prompt from workspace file when present', () => {
    fs.writeFileSync(
      join(testDir, 'prompts', 'morning.md'),
      'Custom morning prompt for {{DATE}} check-in.',
    );
    const prompt = buildPrompt({ type: 'morning' });
    expect(prompt).toContain('Custom morning prompt');
    expect(prompt).not.toContain('Morning Check-in'); // default not used
  });

  it('replaces {{DATE}} placeholder in workspace prompts', () => {
    fs.writeFileSync(
      join(testDir, 'prompts', 'heartbeat.md'),
      'Check memory/{{DATE}}.md for context.',
    );
    const prompt = buildPrompt({ type: 'heartbeat' });
    const today = new Date().toISOString().slice(0, 10);
    expect(prompt).toContain(`memory/${today}.md`);
    expect(prompt).not.toContain('{{DATE}}');
  });

  it('includes reminder text in reminder mode', () => {
    const prompt = buildPrompt({
      type: 'morning',
      reminder: 'Call the dentist',
    });
    expect(prompt).toContain('Call the dentist');
    expect(prompt).toContain('reminder');
    expect(prompt).not.toContain('FOCUS.md');
  });

  it('appends additional context to workspace prompts', () => {
    fs.writeFileSync(
      join(testDir, 'prompts', 'morning.md'),
      'Custom morning prompt.',
    );
    const prompt = buildPrompt({
      type: 'morning',
      context: 'Focus on the API migration today',
    });
    expect(prompt).toContain('Custom morning prompt');
    expect(prompt).toContain('Focus on the API migration today');
    expect(prompt).toContain('Additional Context');
  });

  it('appends additional context to default prompts', () => {
    const prompt = buildPrompt({
      type: 'morning',
      context: 'Focus on the API migration today',
    });
    expect(prompt).toContain('Focus on the API migration today');
    expect(prompt).toContain('Additional Context');
  });

  it('omits context section when not provided', () => {
    const prompt = buildPrompt({ type: 'morning' });
    expect(prompt).not.toContain('Additional Context');
  });
});
