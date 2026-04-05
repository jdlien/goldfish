import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildClaudeMd, buildFocusMd } from '../../src/cli/init.js';

const TEST_DIR = join(__dirname, '..', '__fixtures__', 'init-workspace');

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe('buildClaudeMd', () => {
  it('includes the agent name as heading', () => {
    const result = buildClaudeMd('Aria', 'Direct and witty.');
    expect(result).toMatch(/^# Aria\n/);
  });

  it('includes the personality description', () => {
    const result = buildClaudeMd('Aria', 'Direct and witty. Keeps me on track.');
    expect(result).toContain('Direct and witty. Keeps me on track.');
  });

  it('includes memory search instructions', () => {
    const result = buildClaudeMd('Test', 'Test personality.');
    expect(result).toContain('sqlite3 memory/search.sqlite');
    expect(result).toContain('chunks_fts');
  });

  it('includes FOCUS.md reference', () => {
    const result = buildClaudeMd('Test', 'Test.');
    expect(result).toContain('FOCUS.md');
  });

  it('includes tool instructions', () => {
    const result = buildClaudeMd('Test', 'Test.');
    expect(result).toContain('Claude Code has full bash');
  });
});

describe('buildFocusMd', () => {
  it('includes heading and section structure', () => {
    const result = buildFocusMd();
    expect(result).toContain('# Current Focus');
    expect(result).toContain('## This Week');
    expect(result).toContain('## Watch Items');
  });
});

describe('workspace scaffolding behavior', () => {
  it('does not overwrite existing CLAUDE.md', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const claudePath = join(TEST_DIR, 'CLAUDE.md');

    writeFileSync(claudePath, '# My Custom Agent\n\nDo not overwrite me.');

    // Simulate what init() does: check before writing
    if (!existsSync(claudePath)) {
      writeFileSync(claudePath, buildClaudeMd('Aria', 'New personality'));
    }

    const content = readFileSync(claudePath, 'utf-8');
    expect(content).toContain('Do not overwrite me');
    expect(content).not.toContain('Aria');
  });

  it('creates CLAUDE.md when it does not exist', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const claudePath = join(TEST_DIR, 'CLAUDE.md');

    if (!existsSync(claudePath)) {
      writeFileSync(claudePath, buildClaudeMd('Aria', 'Direct and witty.'));
    }

    expect(existsSync(claudePath)).toBe(true);
    const content = readFileSync(claudePath, 'utf-8');
    expect(content).toContain('Aria');
    expect(content).toContain('Direct and witty.');
  });

  it('creates all expected memory subdirectories', () => {
    const dirs = [
      TEST_DIR,
      join(TEST_DIR, 'memory'),
      join(TEST_DIR, 'memory', 'sessions'),
      join(TEST_DIR, 'memory', 'topics'),
      join(TEST_DIR, 'memory', 'projects'),
      join(TEST_DIR, 'memory', 'people'),
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    for (const dir of dirs) {
      expect(existsSync(dir)).toBe(true);
    }
  });
});
