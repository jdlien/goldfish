/**
 * Memory search — FTS, vector, and hybrid (RRF) retrieval over search.sqlite.
 *
 * Phase 4 of the vector-search-restore plan. FTS works with no model; vector and
 * hybrid need an embedder + a vectorized DB. Hybrid fuses the two ranked lists
 * with Reciprocal Rank Fusion so keyword precision and semantic reach combine.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Embedder } from './embedder.js';

export type SearchMode = 'hybrid' | 'fts' | 'vector';

/** Reciprocal Rank Fusion constant. 60 is the standard default. */
export const RRF_K = 60;

export interface SearchHit {
  chunkId: number;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  sources: ('fts' | 'vector')[];
  ftsRank?: number;
  vectorDistance?: number;
}

export interface SearchResult {
  query: string;
  mode: SearchMode;
  vectorsAvailable: boolean;
  hits: SearchHit[];
}

export interface SearchOptions {
  dbPath: string;
  query: string;
  /** Requested mode. Default: hybrid when vectors are available, else fts. */
  mode?: SearchMode;
  /** Final number of results. Default 10. */
  k?: number;
  /** Per-source candidate pool before fusion. Default 50. */
  poolN?: number;
  /** Embedder for query embedding. Omit → FTS only. */
  embedder?: Embedder | null;
  /** Treat the query as raw FTS5 syntax instead of escaping it. */
  rawFts?: boolean;
}

interface RawHit {
  chunkId: number;
  path: string;
  startLine: number;
  endLine: number;
  snippet?: string;
  text?: string;
  distance?: number;
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression: each token becomes
 * a quoted phrase (operators like AND / * / : / - are neutralized), joined with
 * implicit AND. Returns '' when there are no usable tokens.
 */
export function toFtsMatch(raw: string): string {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

function excerpt(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed;
}

function ftsSearch(db: Database.Database, query: string, limit: number, rawFts: boolean): RawHit[] {
  const expr = rawFts ? query : toFtsMatch(query);
  if (!expr.trim()) return [];
  return db
    .prepare(
      `SELECT chunk_id AS chunkId, path, start_line AS startLine, end_line AS endLine,
              snippet(chunks_fts, 0, '«', '»', '…', 12) AS snippet
       FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(expr, limit) as RawHit[];
}

async function vectorSearch(
  db: Database.Database,
  embedder: Embedder,
  query: string,
  limit: number,
): Promise<RawHit[]> {
  const [qvec] = await embedder.embed([query], 'query');
  const blob = Buffer.from(qvec.buffer, qvec.byteOffset, qvec.byteLength);
  return db
    .prepare(
      `SELECT v.chunk_id AS chunkId, v.distance AS distance,
              c.path, c.start_line AS startLine, c.end_line AS endLine, c.text AS text
       FROM chunks_vec v JOIN chunks c ON c.id = v.chunk_id
       WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`,
    )
    .all(blob, limit) as RawHit[];
}

/** Reciprocal Rank Fusion of the (optional) FTS and vector ranked lists. */
function fuse(ftsHits: RawHit[], vecHits: RawHit[], k: number): SearchHit[] {
  const acc = new Map<number, SearchHit>();
  const add = (hit: RawHit, rank: number, source: 'fts' | 'vector') => {
    const id = Number(hit.chunkId);
    let e = acc.get(id);
    if (!e) {
      e = {
        chunkId: id,
        path: hit.path,
        startLine: hit.startLine,
        endLine: hit.endLine,
        snippet: hit.snippet ?? (hit.text ? excerpt(hit.text) : ''),
        score: 0,
        sources: [],
      };
      acc.set(id, e);
    }
    e.score += 1 / (RRF_K + rank);
    e.sources.push(source);
    if (source === 'fts') {
      e.ftsRank = rank;
      if (hit.snippet) e.snippet = hit.snippet; // prefer the highlighted FTS snippet
    } else {
      e.vectorDistance = hit.distance;
    }
  };
  ftsHits.forEach((h, i) => add(h, i + 1, 'fts'));
  vecHits.forEach((h, i) => add(h, i + 1, 'vector'));
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/** Does this DB connection have a usable vector table? (sqlite-vec must load.) */
function detectVectors(db: Database.Database, embedder: Embedder | null | undefined): boolean {
  if (!embedder) return false;
  try {
    sqliteVec.load(db);
    return !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'chunks_vec'").get();
  } catch {
    return false;
  }
}

export async function searchMemory(opts: SearchOptions): Promise<SearchResult> {
  const { dbPath, query, embedder, rawFts = false } = opts;
  const k = opts.k ?? 10;
  const poolN = opts.poolN ?? 50;

  const db = new Database(dbPath, { readonly: true });
  try {
    const vectorsAvailable = detectVectors(db, embedder);

    let mode: SearchMode = opts.mode ?? (vectorsAvailable ? 'hybrid' : 'fts');
    if ((mode === 'vector' || mode === 'hybrid') && !vectorsAvailable) {
      if (mode === 'vector') {
        throw new Error(
          'Vector search unavailable: no embedding model or the index has no vectors yet. ' +
            'Run `goldfish embeddings setup` and re-index, or use --mode fts.',
        );
      }
      mode = 'fts'; // hybrid gracefully degrades to FTS
    }

    const ftsHits = mode === 'vector' ? [] : ftsSearch(db, query, poolN, rawFts);
    const vecHits =
      mode === 'fts' ? [] : await vectorSearch(db, embedder as Embedder, query, poolN);

    return { query, mode, vectorsAvailable, hits: fuse(ftsHits, vecHits, k) };
  } finally {
    db.close();
  }
}
