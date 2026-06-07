import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  chunkMarkdown,
  chunkByWords,
  chunkFile,
  initSearchDb,
  indexWorkspace,
  findMarkdownFiles,
} from '../../src/lib/memoryIndexer.js';
import { FakeEmbedder } from '../../src/lib/embedder.js';

const TEST_DIR = join(__dirname, '..', '__fixtures__', 'indexer-workspace');
const TEST_DB = join(TEST_DIR, 'test-search.sqlite');

function setupTestWorkspace() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

  mkdirSync(join(TEST_DIR, 'memory', 'sessions'), { recursive: true });
  mkdirSync(join(TEST_DIR, 'memory', 'topics'), { recursive: true });

  writeFileSync(join(TEST_DIR, 'CLAUDE.md'), [
    '# Agent Config', '', 'You are a test agent.', '',
    '## Personality', '', 'Direct and concise.', '',
    '## Memory', '', 'Search with sqlite3.',
  ].join('\n'));

  writeFileSync(join(TEST_DIR, 'FOCUS.md'), [
    '# Current Focus', '',
    '## This Week', '', '- Build the thing', '- Ship the thing', '',
    '## Watch Items', '', '- Deploy deadline Friday',
  ].join('\n'));

  writeFileSync(join(TEST_DIR, 'memory', 'topics', 'architecture.md'), [
    '# Architecture Deep Dive', '', 'Some thoughts on system design.', '',
    '## Component A', '', 'Component A handles the ingestion pipeline.',
    'It processes about 1000 events per second.', '',
    '## Component B', '', 'Component B handles the query layer.',
    'It supports full-text search via FTS5.',
  ].join('\n'));

  writeFileSync(join(TEST_DIR, 'memory', 'sessions', '2026-04-06.jsonl'), [
    '{"role":"user","content":"Hello"}',
    '{"role":"assistant","content":"Hi there!"}',
    '{"role":"user","content":"What are you working on?"}',
  ].join('\n'));

  mkdirSync(join(TEST_DIR, 'node_modules'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'node_modules', 'something.md'), '# Should be excluded');
}

function cleanupTestWorkspace() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

/** Open the test DB with sqlite-vec loaded so vector tables are queryable. */
function openWithVec(): Database.Database {
  const db = new Database(TEST_DB);
  sqliteVec.load(db);
  return db;
}
function vecChunkIds(db: Database.Database): number[] {
  return (db.prepare('SELECT chunk_id FROM chunks_vec').all() as { chunk_id: number }[])
    .map((r) => Number(r.chunk_id));
}

// --- chunkMarkdown ---

describe('chunkMarkdown', () => {
  it('splits on ## headings', () => {
    const text = ['# Title', '', 'Intro paragraph.', '', '## Section One', '',
      'First section content.', '', '## Section Two', '', 'Second section content.'].join('\n');
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].text).toContain('Title');
    expect(chunks[1].text).toContain('Section One');
    expect(chunks[2].text).toContain('Section Two');
  });

  it('keeps single-chunk files intact if under 600 words', () => {
    const chunks = chunkMarkdown('Just a short file with no headings.\n\nA second paragraph.');
    expect(chunks).toHaveLength(1);
  });

  it('falls back to word-based chunking for long files without headings', () => {
    const text = Array(70).fill(Array(10).fill('word').join(' ')).join('\n');
    expect(chunkMarkdown(text).length).toBeGreaterThan(1);
  });

  it('tracks line numbers correctly', () => {
    const text = ['# Title', '', '## Section A', '', 'Content A.', '', '## Section B', '', 'Content B.'].join('\n');
    const chunks = chunkMarkdown(text);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(2);
    expect(chunks[1].startLine).toBe(3);
    expect(chunks[2].startLine).toBe(7);
  });

  it('handles empty input', () => {
    expect(chunkMarkdown('')).toHaveLength(0);
  });

  it('splits on ### and deeper headings', () => {
    expect(chunkMarkdown(['# Doc', '', '### Deep heading', '', 'Content.'].join('\n'))).toHaveLength(2);
  });
});

// --- chunkByWords ---

describe('chunkByWords', () => {
  it('splits long text into ~500 word chunks', () => {
    const text = Array(20).fill(Array(50).fill('word').join(' ')).join('\n');
    expect(chunkByWords(text, 500).length).toBeGreaterThanOrEqual(2);
  });
  it('handles short text as single chunk', () => {
    expect(chunkByWords('Short text.', 500)).toHaveLength(1);
  });
});

// --- chunkFile ---

describe('chunkFile', () => {
  beforeEach(() => setupTestWorkspace());
  afterEach(() => cleanupTestWorkspace());

  it('chunks a markdown file by heading', () => {
    const chunks = chunkFile(join(TEST_DIR, 'memory', 'topics', 'architecture.md'));
    expect(chunks).toHaveLength(3); // Title + Component A + Component B
  });

  it('chunks a JSONL file one chunk per line', () => {
    const chunks = chunkFile(join(TEST_DIR, 'memory', 'sessions', '2026-04-06.jsonl'));
    expect(chunks).toHaveLength(3);
  });
});

// --- initSearchDb ---

describe('initSearchDb', () => {
  beforeEach(() => setupTestWorkspace());
  afterEach(() => cleanupTestWorkspace());

  it('creates the expected tables incl. meta', () => {
    const db = initSearchDb(TEST_DB);
    const names = (db.prepare("SELECT name FROM sqlite_master ORDER BY name").all() as { name: string }[])
      .map((t) => t.name);
    expect(names).toContain('files');
    expect(names).toContain('chunks');
    expect(names).toContain('chunks_fts');
    expect(names).toContain('meta');
    db.close();
  });

  it('records the schema version', () => {
    const db = initSearchDb(TEST_DB);
    const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
    expect(Number(v.value)).toBe(2);
    db.close();
  });

  it('is idempotent — can be called twice', () => {
    initSearchDb(TEST_DB).close();
    initSearchDb(TEST_DB).close();
  });
});

// --- findMarkdownFiles ---

describe('findMarkdownFiles', () => {
  beforeEach(() => setupTestWorkspace());
  afterEach(() => cleanupTestWorkspace());

  it('finds .md and .jsonl files', () => {
    const rel = findMarkdownFiles(TEST_DIR).map((f) => f.replace(TEST_DIR + '/', ''));
    expect(rel).toContain('CLAUDE.md');
    expect(rel).toContain('FOCUS.md');
    expect(rel).toContain('memory/topics/architecture.md');
    expect(rel).toContain('memory/sessions/2026-04-06.jsonl');
  });

  it('excludes node_modules', () => {
    expect(findMarkdownFiles(TEST_DIR).some((f) => f.includes('node_modules'))).toBe(false);
  });
});

// --- indexWorkspace: FTS (no embedder) ---

describe('indexWorkspace (FTS only)', () => {
  beforeEach(() => setupTestWorkspace());
  afterEach(() => cleanupTestWorkspace());

  it('indexes all files and returns correct stats', async () => {
    const stats = await indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'off' });
    expect(stats.indexed).toBe(4);
    expect(stats.skipped).toBe(0);
    expect(stats.removed).toBe(0);
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.vectorEnabled).toBe(false);
  });

  it('skips unchanged files on second run', async () => {
    await indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'off' });
    const stats2 = await indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'off' });
    expect(stats2.indexed).toBe(0);
    expect(stats2.skipped).toBe(4);
  });

  it('re-indexes modified files', async () => {
    await indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'off' });
    writeFileSync(join(TEST_DIR, 'FOCUS.md'), '# Updated Focus\n\nNew content here.');
    const stats2 = await indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'off' });
    expect(stats2.indexed).toBe(1);
    expect(stats2.skipped).toBe(3);
  });

  it('removes deleted files from the index', async () => {
    await indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'off' });
    rmSync(join(TEST_DIR, 'memory', 'topics', 'architecture.md'));
    const stats2 = await indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'off' });
    expect(stats2.removed).toBe(1);
  });

  it('produces a searchable index with chunk_id in FTS', async () => {
    await indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'off' });
    const db = new Database(TEST_DB);
    const results = db.prepare(
      "SELECT path, chunk_id, rowid FROM chunks_fts WHERE chunks_fts MATCH 'deploy deadline'"
    ).all() as { path: string; chunk_id: number; rowid: number }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('FOCUS.md');
    expect(Number(results[0].chunk_id)).toBe(Number(results[0].rowid)); // alignment
    db.close();
  });
});

// --- indexWorkspace: vectors (FakeEmbedder + real sqlite-vec) ---

describe('indexWorkspace (vectors)', () => {
  beforeEach(() => setupTestWorkspace());
  afterEach(() => cleanupTestWorkspace());

  it('creates chunks_vec and inserts one vector per chunk', async () => {
    const stats = await indexWorkspace(TEST_DB, TEST_DIR, {
      embedder: new FakeEmbedder(),
      vectorsMode: 'required',
    });
    expect(stats.vectorEnabled).toBe(true);

    const db = openWithVec();
    const chunkCount = (db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c;
    const vecIds = vecChunkIds(db);
    expect(vecIds.length).toBe(chunkCount);
    expect(stats.vectorsInserted).toBe(chunkCount);
    db.close();
  });

  it('keeps FTS rowid / chunk_id / chunks.id aligned', async () => {
    await indexWorkspace(TEST_DB, TEST_DIR, { embedder: new FakeEmbedder(), vectorsMode: 'required' });
    const db = openWithVec();
    const fts = db.prepare('SELECT rowid, chunk_id FROM chunks_fts').all() as { rowid: number; chunk_id: number }[];
    for (const r of fts) expect(Number(r.rowid)).toBe(Number(r.chunk_id));
    const chunkIds = new Set((db.prepare('SELECT id FROM chunks').all() as { id: number }[]).map((r) => r.id));
    for (const id of vecChunkIds(db)) expect(chunkIds.has(id)).toBe(true);
    db.close();
  });

  it('backfills vectors for unchanged files (the skipped-file trap)', async () => {
    await indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'off' }); // FTS only
    let db = openWithVec();
    // chunks_vec does not exist yet
    const before = db.prepare("SELECT name FROM sqlite_master WHERE name='chunks_vec'").get();
    expect(before).toBeUndefined();
    db.close();

    const stats = await indexWorkspace(TEST_DB, TEST_DIR, { embedder: new FakeEmbedder(), vectorsMode: 'auto' });
    expect(stats.skipped).toBe(4);          // nothing changed
    expect(stats.indexed).toBe(0);
    expect(stats.vectorBackfilled).toBeGreaterThan(0);

    db = openWithVec();
    const chunkCount = (db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c;
    expect(vecChunkIds(db).length).toBe(chunkCount); // every chunk now has a vector
    db.close();
  });

  it('removes vector rows when a file is deleted (no orphans)', async () => {
    await indexWorkspace(TEST_DB, TEST_DIR, { embedder: new FakeEmbedder(), vectorsMode: 'required' });
    rmSync(join(TEST_DIR, 'memory', 'topics', 'architecture.md'));
    await indexWorkspace(TEST_DB, TEST_DIR, { embedder: new FakeEmbedder(), vectorsMode: 'required' });

    const db = openWithVec();
    const chunkCount = (db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c;
    expect(vecChunkIds(db).length).toBe(chunkCount); // counts still match
    db.close();
  });

  it('auto mode without an embedder yields a valid FTS-only index', async () => {
    const stats = await indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'auto' }); // no embedder
    expect(stats.vectorEnabled).toBe(false);
    expect(stats.indexed).toBe(4);
    const db = new Database(TEST_DB);
    expect((db.prepare("SELECT path FROM chunks_fts WHERE chunks_fts MATCH 'pipeline'").all()).length)
      .toBeGreaterThan(0);
    db.close();
  });

  it('required mode without an embedder throws', async () => {
    await expect(
      indexWorkspace(TEST_DB, TEST_DIR, { vectorsMode: 'required' }),
    ).rejects.toThrow();
  });

  it('uses the cache: an identical chunk is not re-embedded; a changed providerKey is', async () => {
    const e1 = new FakeEmbedder({ providerKey: 'k1' });
    await indexWorkspace(TEST_DB, TEST_DIR, { embedder: e1, vectorsMode: 'required' });

    // Append a brand-new section; the existing "Watch Items" chunk text is unchanged.
    writeFileSync(join(TEST_DIR, 'FOCUS.md'), [
      '# Current Focus', '',
      '## This Week', '', '- Build the thing', '- Ship the thing', '',
      '## Watch Items', '', '- Deploy deadline Friday', '',
      '## Brand New Section', '', '- A totally novel line',
    ].join('\n'));

    // Same identity → unchanged chunks hit cache, only the new chunk is embedded.
    const e2 = new FakeEmbedder({ providerKey: 'k1' });
    const stats2 = await indexWorkspace(TEST_DB, TEST_DIR, { embedder: e2, vectorsMode: 'required' });
    expect(stats2.indexed).toBe(1);              // FOCUS.md re-indexed
    expect(stats2.vectorCacheHits).toBeGreaterThan(0);
    // e2 embedded fewer than the full FOCUS chunk set (some came from cache)
    const focusChunks = chunkFile(join(TEST_DIR, 'FOCUS.md')).length;
    expect(e2.seen.length).toBeLessThan(focusChunks);

    // Different providerKey → cache misses, everything in FOCUS re-embedded.
    writeFileSync(join(TEST_DIR, 'FOCUS.md'), [
      '# Current Focus', '', '## This Week', '', '- Build the thing', '- Ship the thing', '',
      '## Watch Items', '', '- Deploy deadline Friday', '',
      '## Brand New Section', '', '- A totally novel line', '', '- one more',
    ].join('\n'));
    const e3 = new FakeEmbedder({ providerKey: 'k3-different' });
    const stats3 = await indexWorkspace(TEST_DB, TEST_DIR, { embedder: e3, vectorsMode: 'required' });
    const focusChunks3 = chunkFile(join(TEST_DIR, 'FOCUS.md')).length;
    expect(stats3.vectorCacheHits).toBe(0);      // nothing cached under k3
    expect(e3.seen.length).toBe(focusChunks3);   // every FOCUS chunk embedded fresh
  });
});
