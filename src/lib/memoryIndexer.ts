/**
 * FTS5 Memory Indexer
 *
 * Walks markdown files in the workspace, chunks them by heading,
 * and builds a full-text search index in SQLite.
 *
 * Replaces the Python indexer (scripts/index-memory.py) with a
 * native TypeScript implementation using better-sqlite3.
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, extname } from 'path';

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
}

/**
 * Initialize the FTS5 database schema.
 */
export function initSearchDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
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

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      path UNINDEXED,
      start_line UNINDEXED,
      end_line UNINDEXED
    );
  `);

  return db;
}

/**
 * SHA-256 hash of file contents.
 */
export function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Split markdown into chunks by ## headings.
 * Falls back to ~500-word blocks if no headings produce multiple chunks.
 */
export function chunkMarkdown(text: string): Chunk[] {
  const lines = text.split('\n');
  const chunks: Chunk[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Split on ## headings (keep # for document title)
    if (/^#{2,6}\s/.test(line) && currentLines.length > 0) {
      const chunkText = currentLines.join('\n').trim();
      if (chunkText) {
        chunks.push({ startLine: currentStart, endLine: lineNum - 1, text: chunkText });
      }
      currentLines = [line];
      currentStart = lineNum;
    } else {
      currentLines.push(line);
    }
  }

  // Last chunk
  if (currentLines.length > 0) {
    const chunkText = currentLines.join('\n').trim();
    if (chunkText) {
      chunks.push({ startLine: currentStart, endLine: lines.length, text: chunkText });
    }
  }

  // If we only got one chunk and it's very long, split by word count
  if (chunks.length === 1 && chunks[0].text.split(/\s+/).length > 600) {
    return chunkByWords(text, 500);
  }

  return chunks;
}

/**
 * Split text into chunks of approximately maxWords words.
 */
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
      if (chunkText) {
        chunks.push({ startLine: currentStart, endLine: lineNum - 1, text: chunkText });
      }
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
    if (chunkText) {
      chunks.push({ startLine: currentStart, endLine: lines.length, text: chunkText });
    }
  }

  return chunks;
}

/**
 * Recursively find all indexable files in the workspace.
 */
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
        if (ext === '.md' || ext === '.jsonl') {
          files.push(fullPath);
        }
      }
    }
  }

  walk(workspace);
  return files.sort();
}

/**
 * Index a single file: chunk it and insert into FTS5.
 */
export function indexFile(db: Database.Database, relPath: string, filePath: string): number {
  const text = readFileSync(filePath, 'utf-8');

  let chunks: Chunk[];

  if (filePath.endsWith('.jsonl')) {
    chunks = text.trim().split('\n')
      .filter(line => line.trim())
      .map((line, i) => ({
        startLine: i + 1,
        endLine: i + 1,
        text: line,
      }));
  } else {
    chunks = chunkMarkdown(text);
  }

  // Remove old chunks for this file
  db.prepare('DELETE FROM chunks WHERE path = ?').run(relPath);
  db.prepare('DELETE FROM chunks_fts WHERE path = ?').run(relPath);

  // Insert new chunks
  const insertChunk = db.prepare(
    'INSERT INTO chunks (path, start_line, end_line, text) VALUES (?, ?, ?, ?)'
  );
  const insertFts = db.prepare(
    'INSERT INTO chunks_fts (text, path, start_line, end_line) VALUES (?, ?, ?, ?)'
  );

  const insertAll = db.transaction((chunks: Chunk[]) => {
    for (const chunk of chunks) {
      insertChunk.run(relPath, chunk.startLine, chunk.endLine, chunk.text);
      insertFts.run(chunk.text, relPath, chunk.startLine, chunk.endLine);
    }
  });

  insertAll(chunks);
  return chunks.length;
}

/**
 * Run the full indexing pipeline.
 */
export function indexWorkspace(dbPath: string, workspacePath: string): IndexStats {
  const db = initSearchDb(dbPath);
  const files = findMarkdownFiles(workspacePath);

  let indexed = 0;
  let skipped = 0;
  let totalChunks = 0;

  const getFileHash = db.prepare('SELECT hash FROM files WHERE path = ?');
  const upsertFile = db.prepare(
    'INSERT OR REPLACE INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)'
  );

  for (const filePath of files) {
    const relPath = relative(workspacePath, filePath);
    const fileHash = hashFile(filePath);

    // Check if file has changed
    const row = getFileHash.get(relPath) as { hash: string } | undefined;
    if (row && row.hash === fileHash) {
      skipped++;
      continue;
    }

    // Index the file
    const numChunks = indexFile(db, relPath, filePath);
    totalChunks += numChunks;

    // Update file record
    const stat = statSync(filePath);
    upsertFile.run(relPath, fileHash, Math.floor(stat.mtimeMs / 1000), stat.size);

    indexed++;
  }

  // Clean up files that no longer exist
  const existingPaths = new Set(files.map(f => relative(workspacePath, f)));
  const dbPaths = (db.prepare('SELECT path FROM files').all() as { path: string }[])
    .map(r => r.path);

  const removedPaths = dbPaths.filter(p => !existingPaths.has(p));

  const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');
  const deleteChunks = db.prepare('DELETE FROM chunks WHERE path = ?');
  const deleteFts = db.prepare('DELETE FROM chunks_fts WHERE path = ?');

  for (const removed of removedPaths) {
    deleteFile.run(removed);
    deleteChunks.run(removed);
    deleteFts.run(removed);
  }

  db.close();

  return { indexed, skipped, removed: removedPaths.length, totalChunks };
}
