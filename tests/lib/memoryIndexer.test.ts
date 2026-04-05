import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  chunkMarkdown,
  chunkByWords,
  initSearchDb,
  indexFile,
  indexWorkspace,
  findMarkdownFiles,
} from '../../src/lib/memoryIndexer.js';

const TEST_DIR = join(__dirname, '..', '__fixtures__', 'indexer-workspace');
const TEST_DB = join(TEST_DIR, 'test-search.sqlite');

function setupTestWorkspace() {
  // Clean up from any prior run
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }

  mkdirSync(join(TEST_DIR, 'memory', 'sessions'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'memory', 'topics'), { recursive: true });

  writeFileSync(join(TEST_DIR, 'CLAUDE.md'), [
    '# Agent Config',
    '',
    'You are a test agent.',
    '',
    '## Personality',
    '',
    'Direct and concise.',
    '',
    '## Memory',
    '',
    'Search with sqlite3.',
  ].join('\n'));

  writeFileSync(join(TEST_DIR, 'FOCUS.md'), [
    '# Current Focus',
    '',
    '## This Week',
    '',
    '- Build the thing',
    '- Ship the thing',
    '',
    '## Watch Items',
    '',
    '- Deploy deadline Friday',
  ].join('\n'));

  writeFileSync(join(TEST_DIR, 'memory', 'topics', 'architecture.md'), [
    '# Architecture Deep Dive',
    '',
    'Some thoughts on system design.',
    '',
    '## Component A',
    '',
    'Component A handles the ingestion pipeline.',
    'It processes about 1000 events per second.',
    '',
    '## Component B',
    '',
    'Component B handles the query layer.',
    'It supports full-text search via FTS5.',
  ].join('\n'));

  writeFileSync(join(TEST_DIR, 'memory', 'sessions', '2026-04-06.jsonl'), [
    '{"role":"user","content":"Hello"}',
    '{"role":"assistant","content":"Hi there!"}',
    '{"role":"user","content":"What are you working on?"}',
  ].join('\n'));

  // A file in an excluded directory (should be skipped)
  mkdirSync(join(TEST_DIR, 'node_modules'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'node_modules', 'something.md'), '# Should be excluded');
}

function cleanupTestWorkspace() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// --- chunkMarkdown ---

describe('chunkMarkdown', () => {
  it('splits on ## headings', () => {
    const text = [
      '# Title',
      '',
      'Intro paragraph.',
      '',
      '## Section One',
      '',
      'First section content.',
      '',
      '## Section Two',
      '',
      'Second section content.',
    ].join('\n');

    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].text).toContain('Title');
    expect(chunks[0].text).toContain('Intro paragraph');
    expect(chunks[1].text).toContain('Section One');
    expect(chunks[2].text).toContain('Section Two');
  });

  it('keeps single-chunk files intact if under 600 words', () => {
    const text = 'Just a short file with no headings.\n\nA second paragraph.';
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('short file');
  });

  it('falls back to word-based chunking for long files without headings', () => {
    // Generate a ~700 word file with no headings, spread across lines
    const lines = Array(70).fill(Array(10).fill('word').join(' '));
    const text = lines.join('\n');
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('tracks line numbers correctly', () => {
    const text = [
      '# Title',       // line 1
      '',              // line 2
      '## Section A',  // line 3
      '',              // line 4
      'Content A.',    // line 5
      '',              // line 6
      '## Section B',  // line 7
      '',              // line 8
      'Content B.',    // line 9
    ].join('\n');

    const chunks = chunkMarkdown(text);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(2);
    expect(chunks[1].startLine).toBe(3);
    expect(chunks[1].endLine).toBe(6);
    expect(chunks[2].startLine).toBe(7);
    expect(chunks[2].endLine).toBe(9);
  });

  it('handles empty input', () => {
    expect(chunkMarkdown('')).toHaveLength(0);
  });

  it('splits on ### and deeper headings', () => {
    const text = [
      '# Doc',
      '',
      '### Deep heading',
      '',
      'Content.',
    ].join('\n');

    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(2);
  });
});

// --- chunkByWords ---

describe('chunkByWords', () => {
  it('splits long text into ~500 word chunks', () => {
    const lines = Array(20).fill(Array(50).fill('word').join(' '));
    const text = lines.join('\n'); // 1000 words
    const chunks = chunkByWords(text, 500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('handles short text as single chunk', () => {
    const chunks = chunkByWords('Short text.', 500);
    expect(chunks).toHaveLength(1);
  });
});

// --- initSearchDb ---

describe('initSearchDb', () => {
  beforeEach(() => setupTestWorkspace());
  afterEach(() => cleanupTestWorkspace());

  it('creates the expected tables', () => {
    const db = initSearchDb(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];

    const names = tables.map(t => t.name);
    expect(names).toContain('files');
    expect(names).toContain('chunks');
    // FTS5 virtual tables show up differently
    const allTables = db.prepare(
      "SELECT name FROM sqlite_master ORDER BY name"
    ).all() as { name: string }[];
    const allNames = allTables.map(t => t.name);
    expect(allNames).toContain('chunks_fts');

    db.close();
  });

  it('is idempotent — can be called twice', () => {
    const db1 = initSearchDb(TEST_DB);
    db1.close();
    const db2 = initSearchDb(TEST_DB);
    db2.close();
  });
});

// --- indexFile ---

describe('indexFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    setupTestWorkspace();
    db = initSearchDb(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupTestWorkspace();
  });

  it('indexes a markdown file into chunks', () => {
    const filePath = join(TEST_DIR, 'memory', 'topics', 'architecture.md');
    const numChunks = indexFile(db, 'memory/topics/architecture.md', filePath);

    expect(numChunks).toBe(3); // Title + Component A + Component B

    const chunks = db.prepare('SELECT * FROM chunks WHERE path = ?')
      .all('memory/topics/architecture.md') as any[];
    expect(chunks).toHaveLength(3);
  });

  it('indexes a JSONL file with one chunk per line', () => {
    const filePath = join(TEST_DIR, 'memory', 'sessions', '2026-04-06.jsonl');
    const numChunks = indexFile(db, 'memory/sessions/2026-04-06.jsonl', filePath);

    expect(numChunks).toBe(3);
  });

  it('replaces old chunks on re-index', () => {
    const filePath = join(TEST_DIR, 'FOCUS.md');

    indexFile(db, 'FOCUS.md', filePath);
    const firstCount = (db.prepare('SELECT COUNT(*) as c FROM chunks WHERE path = ?')
      .get('FOCUS.md') as any).c;

    // Re-index same file
    indexFile(db, 'FOCUS.md', filePath);
    const secondCount = (db.prepare('SELECT COUNT(*) as c FROM chunks WHERE path = ?')
      .get('FOCUS.md') as any).c;

    expect(secondCount).toBe(firstCount);
  });

  it('makes content searchable via FTS5', () => {
    const filePath = join(TEST_DIR, 'memory', 'topics', 'architecture.md');
    indexFile(db, 'memory/topics/architecture.md', filePath);

    const results = db.prepare(
      "SELECT path, snippet(chunks_fts, 0, '>>>', '<<<', '...', 20) as snip FROM chunks_fts WHERE chunks_fts MATCH 'pipeline'"
    ).all() as any[];

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('memory/topics/architecture.md');
    expect(results[0].snip).toContain('pipeline');
  });
});

// --- findMarkdownFiles ---

describe('findMarkdownFiles', () => {
  beforeEach(() => setupTestWorkspace());
  afterEach(() => cleanupTestWorkspace());

  it('finds .md and .jsonl files', () => {
    const files = findMarkdownFiles(TEST_DIR);
    const relPaths = files.map(f => f.replace(TEST_DIR + '/', ''));

    expect(relPaths).toContain('CLAUDE.md');
    expect(relPaths).toContain('FOCUS.md');
    expect(relPaths).toContain('memory/topics/architecture.md');
    expect(relPaths).toContain('memory/sessions/2026-04-06.jsonl');
  });

  it('excludes node_modules', () => {
    const files = findMarkdownFiles(TEST_DIR);
    const hasNodeModules = files.some(f => f.includes('node_modules'));
    expect(hasNodeModules).toBe(false);
  });
});

// --- indexWorkspace (integration) ---

describe('indexWorkspace', () => {
  beforeEach(() => setupTestWorkspace());
  afterEach(() => cleanupTestWorkspace());

  it('indexes all files and returns correct stats', () => {
    const stats = indexWorkspace(TEST_DB, TEST_DIR);

    expect(stats.indexed).toBe(4); // CLAUDE.md, FOCUS.md, architecture.md, session JSONL
    expect(stats.skipped).toBe(0);
    expect(stats.removed).toBe(0);
    expect(stats.totalChunks).toBeGreaterThan(0);
  });

  it('skips unchanged files on second run', () => {
    indexWorkspace(TEST_DB, TEST_DIR);
    const stats2 = indexWorkspace(TEST_DB, TEST_DIR);

    expect(stats2.indexed).toBe(0);
    expect(stats2.skipped).toBe(4);
  });

  it('re-indexes modified files', () => {
    indexWorkspace(TEST_DB, TEST_DIR);

    // Modify a file
    writeFileSync(join(TEST_DIR, 'FOCUS.md'), '# Updated Focus\n\nNew content here.');

    const stats2 = indexWorkspace(TEST_DB, TEST_DIR);
    expect(stats2.indexed).toBe(1);
    expect(stats2.skipped).toBe(3);
  });

  it('removes deleted files from the index', () => {
    indexWorkspace(TEST_DB, TEST_DIR);

    // Delete a file
    rmSync(join(TEST_DIR, 'memory', 'topics', 'architecture.md'));

    const stats2 = indexWorkspace(TEST_DB, TEST_DIR);
    expect(stats2.removed).toBe(1);
  });

  it('produces a searchable index', () => {
    indexWorkspace(TEST_DB, TEST_DIR);

    const db = new Database(TEST_DB);
    const results = db.prepare(
      "SELECT path FROM chunks_fts WHERE chunks_fts MATCH 'deploy deadline'"
    ).all() as any[];

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('FOCUS.md');
    db.close();
  });
});
