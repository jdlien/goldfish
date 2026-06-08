import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { indexWorkspace } from '../../src/lib/memoryIndexer.js';
import { searchMemory, toFtsMatch } from '../../src/lib/memorySearch.js';
import { formatJson } from '../../src/cli/search.js';
import { l2normalize, type Embedder, type EmbeddingKind } from '../../src/lib/embedder.js';

const DIR = join(__dirname, '..', '__fixtures__', 'search-workspace');
const DB = join(DIR, 'search.sqlite');

/**
 * Deterministic, content-keyed embedder. Vector depends on which marker word a
 * text contains — and is prefix/kind-independent — so a query can land near a
 * document even with NO shared FTS tokens (the semantic case), and ordering is
 * fully assertable.
 */
class ScriptedEmbedder implements Embedder {
  readonly dims = 4;
  readonly provider = 'scripted';
  readonly model = 'scripted-v1';
  readonly providerKey = 'k';
  async embed(texts: string[], _kind: EmbeddingKind): Promise<Float32Array[]> {
    return texts.map((t) => l2normalize(Float32Array.from(ScriptedEmbedder.vecFor(t))));
  }
  static vecFor(text: string): number[] {
    if (text.includes('xyzzy') || text.includes('magicword')) return [1, 0, 0, 0];
    if (text.includes('garden')) return [0, 1, 0, 0];
    if (text.includes('finance')) return [0, 0, 1, 0];
    return [0, 0, 0, 1];
  }
}

function setup() {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'docA.md'), '# Doc A\n\nThe xyzzy keyword lives here with plants.');
  writeFileSync(join(DIR, 'docB.md'), '# Doc B\n\nNotes about gardens and soil.');
  writeFileSync(join(DIR, 'docC.md'), '# Doc C\n\nUnrelated content about finance.');
}
function cleanup() {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true });
}

describe('toFtsMatch', () => {
  it('quotes each token and neutralizes operators', () => {
    expect(toFtsMatch('deploy deadline')).toBe('"deploy" "deadline"');
    expect(toFtsMatch('foo AND (bar)')).toBe('"foo" "AND" "bar"'); // AND becomes a literal token
  });
  it('drops punctuation-only input to empty', () => {
    expect(toFtsMatch('!!! ??? ...')).toBe('');
  });
  it('doubles embedded quotes', () => {
    expect(toFtsMatch('say "hi"')).toBe('"say" "hi"');
  });
});

describe('searchMemory', () => {
  beforeEach(async () => {
    setup();
    await indexWorkspace(DB, DIR, { embedder: new ScriptedEmbedder(), vectorsMode: 'required' });
  });
  afterEach(() => cleanup());

  it('fts mode works with no embedder', async () => {
    const r = await searchMemory({ dbPath: DB, query: 'xyzzy', mode: 'fts', embedder: null });
    expect(r.mode).toBe('fts');
    expect(r.hits.length).toBe(1);
    expect(r.hits[0].path).toBe('docA.md');
    expect(r.hits[0].sources).toEqual(['fts']);
  });

  it('vector mode retrieves a doc with NO keyword overlap', async () => {
    // "magicword" appears in no document body, but maps to docA's vector.
    const fts = await searchMemory({ dbPath: DB, query: 'magicword', mode: 'fts', embedder: null });
    expect(fts.hits.length).toBe(0); // FTS finds nothing

    const vec = await searchMemory({
      dbPath: DB, query: 'magicword', mode: 'vector', embedder: new ScriptedEmbedder(),
    });
    expect(vec.mode).toBe('vector');
    expect(vec.hits[0].path).toBe('docA.md'); // semantic hit despite zero token overlap
    expect(vec.hits[0].sources).toEqual(['vector']);
    expect(vec.hits[0].vectorDistance).toBeDefined();
  });

  it('vector mode throws when vectors are unavailable', async () => {
    await expect(
      searchMemory({ dbPath: DB, query: 'anything', mode: 'vector', embedder: null }),
    ).rejects.toThrow(/Vector search unavailable/);
  });

  it('hybrid fuses + de-duplicates a doc hit by both FTS and vector', async () => {
    const r = await searchMemory({
      dbPath: DB, query: 'xyzzy', mode: 'hybrid', embedder: new ScriptedEmbedder(),
    });
    expect(r.mode).toBe('hybrid');
    const docA = r.hits.filter((h) => h.path === 'docA.md');
    expect(docA).toHaveLength(1); // de-duplicated, not double-counted
    expect(docA[0].sources.sort()).toEqual(['fts', 'vector']); // both contributed
    expect(docA[0].score).toBeGreaterThan(0);
    expect(docA[0]).toBe(r.hits[0]); // top result (highest RRF score)
  });

  it('hybrid degrades to fts when no embedder is available', async () => {
    const r = await searchMemory({ dbPath: DB, query: 'xyzzy', mode: 'hybrid', embedder: null });
    expect(r.mode).toBe('fts');
    expect(r.vectorsAvailable).toBe(false);
  });

  it('escapes punctuation/quotes without throwing', async () => {
    const r = await searchMemory({
      dbPath: DB, query: 'plants "AND" (soil)!', mode: 'fts', embedder: null,
    });
    expect(Array.isArray(r.hits)).toBe(true); // did not throw on FTS syntax
  });

  it('respects k', async () => {
    const r = await searchMemory({ dbPath: DB, query: 'doc', mode: 'fts', embedder: null, k: 1 });
    expect(r.hits.length).toBeLessThanOrEqual(1);
  });
});

describe('formatJson', () => {
  beforeEach(async () => {
    setup();
    await indexWorkspace(DB, DIR, { embedder: new ScriptedEmbedder(), vectorsMode: 'required' });
  });
  afterEach(() => cleanup());

  it('produces a stable JSON shape for tools', async () => {
    const r = await searchMemory({ dbPath: DB, query: 'xyzzy', mode: 'fts', embedder: null });
    const parsed = JSON.parse(formatJson(r));
    expect(parsed).toMatchObject({ query: 'xyzzy', mode: 'fts', count: 1 });
    expect(parsed.results[0]).toMatchObject({ path: 'docA.md', sources: ['fts'] });
    expect(typeof parsed.results[0].chunkId).toBe('number');
    expect(typeof parsed.results[0].score).toBe('number');
    expect(typeof parsed.results[0].snippet).toBe('string');
  });
});
