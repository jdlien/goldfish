import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = join(process.cwd(), 'scripts', 'daily-synthesis.sh');
const DATE = '2026-07-02';

let workspace: string;
let stubBin: string;
let dailyFile: string;

/**
 * Stub stands in for the `claude` CLI. It deliberately misbehaves the way the real
 * model did: echoes the document title and a section the daily file already has,
 * alongside one genuinely new section. The script must keep only the new one.
 */
const STUB_OUTPUT = `# Daily Log — ${DATE} (Thursday)

Some restated preamble that should never survive.

## Desk Saga

The desk arrived and one motor rattled. (This duplicates the hand-written notes.)

## Evening — Caltrops

Looked up the etymology. Named after the puncture vine, not the other way round.
`;

const HUMAN_CONTENT = `# Daily Log — ${DATE}

## Desk Saga

The desk arrived and one motor rattled from the very first movement.

## Morning Coffee

Kicking Horse, AeroPress, black.
`;

function runScript(): string {
  return execFileSync('bash', [SCRIPT], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      GOLDFISH_WORKSPACE: workspace,
      GOLDFISH_SYNTHESIS_DATE: DATE,
      GOLDFISH_CLAUDE_BIN: stubBin,
    },
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(join(tmpdir(), 'goldfish-synthesis-'));
  fs.mkdirSync(join(workspace, 'memory', 'sessions'), { recursive: true });

  fs.writeFileSync(
    join(workspace, 'memory', 'sessions', `${DATE}.jsonl`),
    `${JSON.stringify({ timestamp: `${DATE}T18:00:00Z`, text: 'the desk rattled' })}\n`
  );

  dailyFile = join(workspace, 'memory', `${DATE}.md`);
  fs.writeFileSync(dailyFile, HUMAN_CONTENT);

  stubBin = join(workspace, 'fake-claude.sh');
  fs.writeFileSync(stubBin, `#!/bin/bash\ncat <<'STUB_EOF'\n${STUB_OUTPUT}\nSTUB_EOF\n`);
  fs.chmodSync(stubBin, 0o755);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe('daily-synthesis.sh', () => {
  it('appends a synthesis block without duplicating hand-written content', () => {
    runScript();
    const result = fs.readFileSync(dailyFile, 'utf-8');

    // Hand-written notes survive verbatim, exactly once.
    expect(result).toContain('The desk arrived and one motor rattled from the very first movement.');
    expect(occurrences(result, '## Desk Saga')).toBe(1);
    expect(occurrences(result, '## Morning Coffee')).toBe(1);

    // The genuinely new section is appended, inside markers.
    expect(occurrences(result, '## Evening — Caltrops')).toBe(1);
    expect(occurrences(result, '<!-- goldfish:auto-synthesis:start -->')).toBe(1);
    expect(occurrences(result, '<!-- goldfish:auto-synthesis:end -->')).toBe(1);
  });

  it('drops echoed content the daily file already contains', () => {
    runScript();
    const result = fs.readFileSync(dailyFile, 'utf-8');

    // The stub re-emitted the Desk Saga section and the document title. Neither lands.
    expect(result).not.toContain('This duplicates the hand-written notes.');
    expect(result).not.toContain('Some restated preamble');
    expect(occurrences(result, `# Daily Log — ${DATE}`)).toBe(1);
  });

  it('is idempotent — a second run leaves the file byte-identical', () => {
    runScript();
    const first = fs.readFileSync(dailyFile, 'utf-8');

    runScript();
    const second = fs.readFileSync(dailyFile, 'utf-8');

    expect(second).toBe(first);
    expect(occurrences(second, '## Auto-Synthesis (1 AM)')).toBe(1);
    expect(occurrences(second, '## Evening — Caltrops')).toBe(1);
  });

  it('leaves the file untouched when the model adds nothing new', () => {
    fs.writeFileSync(stubBin, `#!/bin/bash\necho NOTHING_NEW\n`);
    fs.chmodSync(stubBin, 0o755);

    runScript();

    expect(fs.readFileSync(dailyFile, 'utf-8')).toBe(HUMAN_CONTENT);
  });

  it('skips cleanly when there are no sessions for the date', () => {
    fs.rmSync(join(workspace, 'memory', 'sessions', `${DATE}.jsonl`));

    const output = runScript();

    expect(output).toContain('skipping');
    expect(fs.readFileSync(dailyFile, 'utf-8')).toBe(HUMAN_CONTENT);
  });
});
