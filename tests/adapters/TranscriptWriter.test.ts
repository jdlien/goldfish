import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { makeTranscriptEntry } from '../helpers/fixtures.js';

const testDir = join(tmpdir(), `goldfish-test-${crypto.randomUUID()}`);

vi.mock('../../src/config.js', () => ({
  SESSIONS_PATH: testDir,
  WORKSPACE_PATH: testDir,
  SEARCH_DB_PATH: join(testDir, 'search.sqlite'),
  DEFAULT_MAX_TURNS: 50,
  DEFAULT_TIMEOUT_MS: 300000,
  SESSION_EXPIRY_MS: 86400000,
}));

const { writeTranscript } = await import('../../src/adapters/TranscriptWriter.js');

beforeEach(() => {
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe('writeTranscript', () => {
  it('creates directory and writes JSONL line', () => {
    writeTranscript(makeTranscriptEntry());

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(testDir, `${today}.jsonl`);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8').trim()).toBeTruthy();
  });

  it('appends to existing file on second write', () => {
    writeTranscript(makeTranscriptEntry({ userMessage: 'first' }));
    writeTranscript(makeTranscriptEntry({ userMessage: 'second' }));

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(testDir, `${today}.jsonl`);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('writes parseable JSON per line', () => {
    writeTranscript(makeTranscriptEntry({ userMessage: 'parse me' }));

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(testDir, `${today}.jsonl`);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').trim());
    expect(parsed.userMessage).toBe('parse me');
    expect(parsed.assistantResponse).toBe('Hi there!');
  });

  it('includes all entry fields in written JSON', () => {
    const entry = makeTranscriptEntry({
      slackChannel: 'C_CUSTOM',
      claudeSessionId: 'sess-xyz',
      durationMs: 2500,
    });
    writeTranscript(entry);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(testDir, `${today}.jsonl`);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').trim());
    expect(parsed.slackChannel).toBe('C_CUSTOM');
    expect(parsed.claudeSessionId).toBe('sess-xyz');
    expect(parsed.durationMs).toBe(2500);
  });
});
