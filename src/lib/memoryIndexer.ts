/**
 * Memory Indexer — FTS5 + optional semantic vectors.
 *
 * Walks markdown/JSONL files in the workspace, chunks them, and builds a SQLite
 * search index: always full-text (FTS5), and — when an embedder is available —
 * a parallel sqlite-vec vector table for semantic search.
 *
 * Design constraints (vector-search-restore plan, Phase 2 / D8):
 *  - Embeddings are async; compute them BEFORE the better-sqlite3 transaction
 *    (never await inside a sync transaction).
 *  - FTS rows carry `chunk_id` and use `rowid = chunks.id` so FTS and vector
 *    hits fuse on one key.
 *  - Vector work is strictly additive: in `auto` mode a missing/broken embedder
 *    still yields a valid FTS-only index; `required` mode fails loudly.
 *  - Deletion order: remove a chunk's vector row before the chunk itself.
 *  - Unchanged files are still scanned for MISSING vectors and backfilled, so an
 *    existing FTS-only DB gains vectors without a content change.
 *
 * Run via schedule (index-memory task) or CLI: node dist/index.js index-memory
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { createChildLogger } from './logger.js';
import type { Embedder } from './embedder.js';
import type { MemoryVectorsMode } from '../config.js';

const log = createChildLogger('memory-indexer');

/** Bump when the on-disk schema changes in a way that needs a rebuild. */
const SCHEMA_VERSION = 2;

export interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
}

export interface IndexStats {
  indexed: number;
  skipped: number;
  removed: number;
  totalChunks: number;
  // Vector stats (zero when vectors are disabled)
  vectorsInserted: number;
  vectorCacheHits: number;
  vectorFailures: number;
  vectorBackfilled: number;
  vectorEnabled: boolean;
}

export interface IndexOptions {
  /** Embedder for semantic vectors. Omit/null → FTS only. */
  embedder?: Embedder | null;
  /** off | auto | required. Default 'auto'. */
  vectorsMode?: MemoryVectorsMode;
}

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers (chunking / hashing / file discovery) — unchanged behavior
// ────────────────────────────────────────────────────────────────────────────

export function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Split markdown into chunks by ## headings; fall back to ~500-word blocks. */
export function chunkMarkdown(text: string): Chunk[] {
  const lines = text.split('\n');
  const chunks: Chunk[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    if (/^#{2,6}\s/.test(line) && currentLines.length > 0) {
      const chunkText = currentLines.join('\n').trim();
      if (chunkText) chunks.push({ startLine: currentStart, endLine: lineNum - 1, text: chunkText });
      currentLines = [line];
      currentStart = lineNum;
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    const chunkText = currentLines.join('\n').trim();
    if (chunkText) chunks.push({ startLine: currentStart, endLine: lines.length, text: chunkText });
  }
  if (chunks.length === 1 && chunks[0].text.split(/\s+/).length > 600) {
    return chunkByWords(text, 500);
  }
  return chunks;
}

/** Split text into chunks of approximately maxWords words. */
export function chunkByWords(text: string, maxWords: number = 500): Chunk[] {
  const lines = text.split('\n');
  const chunks: Chunk[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;
  let wordCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    const lineWords = line.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount + lineWords > maxWords && currentLines.length > 0) {
      const chunkText = currentLines.join('\n').trim();
      if (chunkText) chunks.push({ startLine: currentStart, endLine: lineNum - 1, text: chunkText });
      currentLines = [line];
      currentStart = lineNum;
      wordCount = lineWords;
    } else {
      currentLines.push(line);
      wordCount += lineWords;
    }
  }
  if (currentLines.length > 0) {
    const chunkText = currentLines.join('\n').trim();
    if (chunkText) chunks.push({ startLine: currentStart, endLine: lines.length, text: chunkText });
  }
  return chunks;
}

/** Chunk a file by type (JSONL → one chunk per line; else markdown headings). */
export function chunkFile(filePath: string): Chunk[] {
  const text = readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.jsonl')) {
    return text.trim().split('\n')
      .filter(line => line.trim())
      .map((line, i) => ({ startLine: i + 1, endLine: i + 1, text: line }));
  }
  return chunkMarkdown(text);
}

export function findMarkdownFiles(workspace: string): string[] {
  const files: string[] = [];
  const excluded = new Set(['.git', 'node_modules', 'dist', 'code', '.claude']);

  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.md' || ext === '.jsonl') files.push(fullPath);
      }
    }
  }
  walk(workspace);
  return files.sort();
}

// ────────────────────────────────────────────────────────────────────────────
// Schema / DB setup
// ────────────────────────────────────────────────────────────────────────────

function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}
function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

/**
 * Initialize the FTS5 schema + meta table, migrating an older FTS-only DB.
 * Vector tables are created separately (only when an embedder is available).
 */
export function initSearchDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
  `);

  const version = Number(getMeta(db, 'schema_version') ?? 0);
  if (version < SCHEMA_VERSION) {
    // v2 introduces chunk_id in FTS + rowid alignment. The old FTS rows have no
    // chunk_id and arbitrary rowids, so rebuild FTS and force a full re-index
    // (clear chunks + files). FTS/vector content is derived, so this is safe.
    db.exec('DROP TABLE IF EXISTS chunks_fts');
    db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text,
        chunk_id UNINDEXED,
        path UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED
      );
    `);
    db.exec('DELETE FROM chunks');
    db.exec('DELETE FROM files');
    setMeta(db, 'schema_version', String(SCHEMA_VERSION));
    if (version > 0) {
      log.info({ from: version, to: SCHEMA_VERSION }, 'Migrated memory index schema (full re-index)');
    }
  }

  return db;
}

interface VectorCtx {
  embedder: Embedder;
  dims: number;
  lookupCache: Database.Statement;
  upsertCache: Database.Statement;
  insertVec: Database.Statement;
  deleteVec: Database.Statement;
}

/**
 * Try to enable vectors on this DB connection. Returns a VectorCtx or null.
 * In `required` mode, throws if vectors can't be enabled. In `auto`, returns
 * null and logs a warning (FTS-only continues).
 */
function setupVectors(
  db: Database.Database,
  mode: MemoryVectorsMode,
  embedder: Embedder | null | undefined,
): VectorCtx | null {
  if (mode === 'off') return null;
  if (!embedder) {
    if (mode === 'required') {
      throw new Error('GOLDFISH_MEMORY_VECTORS=required but no embedder is available.');
    }
    return null;
  }
  try {
    sqliteVec.load(db);
    db.prepare('SELECT vec_version()').get();
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${embedder.dims}] distance_metric=cosine
      );
      CREATE TABLE IF NOT EXISTS embedding_cache (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('document','query')),
        hash TEXT NOT NULL,
        dims INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, kind, hash)
      );
    `);
    return {
      embedder,
      dims: embedder.dims,
      lookupCache: db.prepare(
        `SELECT embedding FROM embedding_cache
         WHERE provider=? AND model=? AND provider_key=? AND kind='document' AND hash=?`,
      ),
      upsertCache: db.prepare(
        `INSERT OR REPLACE INTO embedding_cache
         (provider, model, provider_key, kind, hash, dims, embedding, updated_at)
         VALUES (?, ?, ?, 'document', ?, ?, ?, ?)`,
      ),
      insertVec: db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)'),
      deleteVec: db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?'),
    };
  } catch (err) {
    if (mode === 'required') throw err;
    log.warn({ err }, 'sqlite-vec/vector setup failed — continuing FTS-only');
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Vector encoding helpers
// ────────────────────────────────────────────────────────────────────────────

function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function blobToVec(b: Buffer): Float32Array {
  // Copy into an aligned buffer to be safe about byteOffset alignment.
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/**
 * Resolve document vectors for a set of chunk texts, cache-first. Embeds only
 * the cache misses (one batch). Returns a vector per text, or null entries if
 * embedding failed (auto mode tolerates this; required mode rethrows upstream).
 */
async function resolveDocumentVectors(
  vctx: VectorCtx,
  texts: string[],
  stats: IndexStats,
): Promise<(Float32Array | null)[]> {
  const { embedder } = vctx;
  const result: (Float32Array | null)[] = new Array(texts.length).fill(null);
  const missIdx: number[] = [];
  const missTexts: string[] = [];

  texts.forEach((text, i) => {
    const hit = vctx.lookupCache.get(
      embedder.provider, embedder.model, embedder.providerKey, hashText(text),
    ) as { embedding: Buffer } | undefined;
    if (hit) {
      result[i] = blobToVec(hit.embedding);
      stats.vectorCacheHits++;
    } else {
      missIdx.push(i);
      missTexts.push(text);
    }
  });

  if (missTexts.length > 0) {
    const embedded = await embedder.embed(missTexts, 'document');
    embedded.forEach((vec, k) => {
      result[missIdx[k]] = vec;
    });
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Indexing
// ────────────────────────────────────────────────────────────────────────────

/**
 * Re-index a single changed file: chunk it, resolve vectors (pre-transaction),
 * then atomically replace its chunks / FTS / vector rows.
 */
async function reindexFile(
  db: Database.Database,
  relPath: string,
  filePath: string,
  vctx: VectorCtx | null,
  mode: MemoryVectorsMode,
  stats: IndexStats,
): Promise<number> {
  const chunks = chunkFile(filePath);

  // Embeddings (async) BEFORE the transaction.
  let vectors: (Float32Array | null)[] | null = null;
  if (vctx) {
    try {
      vectors = await resolveDocumentVectors(vctx, chunks.map(c => c.text), stats);
    } catch (err) {
      if (mode === 'required') throw err;
      log.warn({ err, path: relPath }, 'Embedding failed — indexing FTS-only for this file');
      stats.vectorFailures += chunks.length;
      vectors = null;
    }
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    // Deletion order: vector rows first (by existing chunk ids), then chunks/FTS.
    if (vctx) {
      const oldIds = db.prepare('SELECT id FROM chunks WHERE path = ?').all(relPath) as { id: number }[];
      for (const { id } of oldIds) vctx.deleteVec.run(BigInt(id));
    }
    db.prepare('DELETE FROM chunks WHERE path = ?').run(relPath);
    db.prepare('DELETE FROM chunks_fts WHERE path = ?').run(relPath);

    const insertChunk = db.prepare(
      'INSERT INTO chunks (path, start_line, end_line, text) VALUES (?, ?, ?, ?)',
    );
    const insertFts = db.prepare(
      'INSERT INTO chunks_fts (rowid, text, chunk_id, path, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)',
    );

    chunks.forEach((chunk, i) => {
      const id = Number(insertChunk.run(relPath, chunk.startLine, chunk.endLine, chunk.text).lastInsertRowid);
      insertFts.run(id, chunk.text, id, relPath, chunk.startLine, chunk.endLine);
      const vec = vectors?.[i] ?? null;
      if (vctx && vec) {
        const blob = vecToBlob(vec);
        vctx.insertVec.run(BigInt(id), blob);
        vctx.upsertCache.run(
          vctx.embedder.provider, vctx.embedder.model, vctx.embedder.providerKey,
          hashText(chunk.text), vctx.dims, blob, now,
        );
        stats.vectorsInserted++;
      } else if (vctx && vectors) {
        stats.vectorFailures++;
      }
    });
  });
  tx();
  return chunks.length;
}

/**
 * Backfill missing vectors for an unchanged file: embed only chunks that have
 * no vector row yet. This is what lets an existing FTS-only DB gain vectors.
 */
async function backfillFileVectors(
  db: Database.Database,
  relPath: string,
  vctx: VectorCtx,
  vectorizedIds: Set<number>,
  mode: MemoryVectorsMode,
  stats: IndexStats,
): Promise<void> {
  const rows = db.prepare('SELECT id, text FROM chunks WHERE path = ?').all(relPath) as
    { id: number; text: string }[];
  const missing = rows.filter(r => !vectorizedIds.has(r.id));
  if (missing.length === 0) return;

  let vectors: (Float32Array | null)[];
  try {
    vectors = await resolveDocumentVectors(vctx, missing.map(m => m.text), stats);
  } catch (err) {
    if (mode === 'required') throw err;
    log.warn({ err, path: relPath }, 'Backfill embedding failed — leaving FTS-only for this file');
    stats.vectorFailures += missing.length;
    return;
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    missing.forEach((m, i) => {
      const vec = vectors[i];
      if (!vec) {
        stats.vectorFailures++;
        return;
      }
      const blob = vecToBlob(vec);
      vctx.insertVec.run(BigInt(m.id), blob);
      vctx.upsertCache.run(
        vctx.embedder.provider, vctx.embedder.model, vctx.embedder.providerKey,
        hashText(m.text), vctx.dims, blob, now,
      );
      vectorizedIds.add(m.id);
      stats.vectorsInserted++;
      stats.vectorBackfilled++;
    });
  });
  tx();
}

/**
 * Run the full indexing pipeline. Async because embedding is async.
 */
export async function indexWorkspace(
  dbPath: string,
  workspacePath: string,
  options: IndexOptions = {},
): Promise<IndexStats> {
  const mode: MemoryVectorsMode = options.vectorsMode ?? 'auto';
  const db = initSearchDb(dbPath);
  const vctx = setupVectors(db, mode, options.embedder);

  const stats: IndexStats = {
    indexed: 0, skipped: 0, removed: 0, totalChunks: 0,
    vectorsInserted: 0, vectorCacheHits: 0, vectorFailures: 0, vectorBackfilled: 0,
    vectorEnabled: !!vctx,
  };

  try {
    const files = findMarkdownFiles(workspacePath);

    // Snapshot which chunk ids already have vectors (drives backfill).
    const vectorizedIds = new Set<number>();
    if (vctx) {
      for (const r of db.prepare('SELECT chunk_id FROM chunks_vec').all() as { chunk_id: number }[]) {
        vectorizedIds.add(Number(r.chunk_id));
      }
    }

    const getFileHash = db.prepare('SELECT hash FROM files WHERE path = ?');
    const upsertFile = db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)',
    );

    for (const filePath of files) {
      const relPath = relative(workspacePath, filePath);
      const fileHash = hashFile(filePath);
      const row = getFileHash.get(relPath) as { hash: string } | undefined;

      if (row && row.hash === fileHash) {
        stats.skipped++;
        if (vctx) await backfillFileVectors(db, relPath, vctx, vectorizedIds, mode, stats);
        continue;
      }

      const numChunks = await reindexFile(db, relPath, filePath, vctx, mode, stats);
      stats.totalChunks += numChunks;
      const stat = statSync(filePath);
      upsertFile.run(relPath, fileHash, Math.floor(stat.mtimeMs / 1000), stat.size);
      stats.indexed++;
    }

    // Remove files that no longer exist (vectors first, then chunks/FTS/files).
    const existingPaths = new Set(files.map(f => relative(workspacePath, f)));
    const dbPaths = (db.prepare('SELECT path FROM files').all() as { path: string }[]).map(r => r.path);
    const removedPaths = dbPaths.filter(p => !existingPaths.has(p));

    const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');
    const deleteChunks = db.prepare('DELETE FROM chunks WHERE path = ?');
    const deleteFts = db.prepare('DELETE FROM chunks_fts WHERE path = ?');

    for (const removed of removedPaths) {
      if (vctx) {
        const ids = db.prepare('SELECT id FROM chunks WHERE path = ?').all(removed) as { id: number }[];
        for (const { id } of ids) vctx.deleteVec.run(BigInt(id));
      }
      deleteFile.run(removed);
      deleteChunks.run(removed);
      deleteFts.run(removed);
    }
    stats.removed = removedPaths.length;

    return stats;
  } finally {
    db.close();
  }
}
