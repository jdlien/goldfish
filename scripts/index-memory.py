#!/usr/bin/env python3
"""
FTS5 Memory Indexer for Goldfish

Walks markdown files in the workspace, chunks them by heading,
and builds a full-text search index in SQLite.

Usage:
  python3 index-memory.py <db_path> <workspace_path>

Example:
  python3 index-memory.py memory/search.sqlite ~/goldfish-workspace
"""

import hashlib
import os
import re
import sqlite3
import sys
from pathlib import Path


def init_db(db_path: str) -> sqlite3.Connection:
    """Create or open the FTS5 database."""
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    conn.executescript("""
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
    """)
    return conn


def hash_file(path: Path) -> str:
    """SHA256 hash of file contents."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def chunk_markdown(text: str) -> list[dict]:
    """
    Split markdown into chunks by ## headings.
    Falls back to ~500-word blocks if no headings found.
    """
    lines = text.split("\n")
    chunks = []
    current_chunk_lines: list[str] = []
    current_start = 1

    for i, line in enumerate(lines, 1):
        # Split on ## headings (but keep # for document title)
        if re.match(r"^#{2,6}\s", line) and current_chunk_lines:
            chunk_text = "\n".join(current_chunk_lines).strip()
            if chunk_text:
                chunks.append({
                    "start_line": current_start,
                    "end_line": i - 1,
                    "text": chunk_text,
                })
            current_chunk_lines = [line]
            current_start = i
        else:
            current_chunk_lines.append(line)

    # Don't forget the last chunk
    if current_chunk_lines:
        chunk_text = "\n".join(current_chunk_lines).strip()
        if chunk_text:
            chunks.append({
                "start_line": current_start,
                "end_line": len(lines),
                "text": chunk_text,
            })

    # If we only got one chunk and it's very long, split by word count
    if len(chunks) == 1 and len(chunks[0]["text"].split()) > 600:
        return chunk_by_words(text, max_words=500)

    return chunks


def chunk_by_words(text: str, max_words: int = 500) -> list[dict]:
    """Split text into chunks of approximately max_words words."""
    lines = text.split("\n")
    chunks = []
    current_lines: list[str] = []
    current_start = 1
    word_count = 0

    for i, line in enumerate(lines, 1):
        line_words = len(line.split())
        if word_count + line_words > max_words and current_lines:
            chunk_text = "\n".join(current_lines).strip()
            if chunk_text:
                chunks.append({
                    "start_line": current_start,
                    "end_line": i - 1,
                    "text": chunk_text,
                })
            current_lines = [line]
            current_start = i
            word_count = line_words
        else:
            current_lines.append(line)
            word_count += line_words

    if current_lines:
        chunk_text = "\n".join(current_lines).strip()
        if chunk_text:
            chunks.append({
                "start_line": current_start,
                "end_line": len(lines),
                "text": chunk_text,
            })

    return chunks


def find_markdown_files(workspace: Path) -> list[Path]:
    """Find all indexable markdown files in the workspace."""
    patterns = [
        "*.md",
        "memory/**/*.md",
        "identity/**/*.md",
        "memory/sessions/*.jsonl",
    ]

    files = set()
    for pattern in patterns:
        files.update(workspace.glob(pattern))

    # Exclude some directories
    excluded = {".git", "node_modules", "dist", "code", ".claude"}
    return [
        f for f in sorted(files)
        if not any(part in excluded for part in f.relative_to(workspace).parts)
    ]


def index_file(conn: sqlite3.Connection, rel_path: str, file_path: Path):
    """Index a single file: chunk it and insert into FTS5."""
    text = file_path.read_text(encoding="utf-8", errors="replace")

    # For JSONL files, just index each line as a chunk
    if file_path.suffix == ".jsonl":
        chunks = []
        for i, line in enumerate(text.strip().split("\n"), 1):
            if line.strip():
                chunks.append({"start_line": i, "end_line": i, "text": line})
    else:
        chunks = chunk_markdown(text)

    # Remove old chunks for this file
    conn.execute("DELETE FROM chunks WHERE path = ?", (rel_path,))
    conn.execute("DELETE FROM chunks_fts WHERE path = ?", (rel_path,))

    # Insert new chunks
    for chunk in chunks:
        conn.execute(
            "INSERT INTO chunks (path, start_line, end_line, text) VALUES (?, ?, ?, ?)",
            (rel_path, chunk["start_line"], chunk["end_line"], chunk["text"]),
        )
        conn.execute(
            "INSERT INTO chunks_fts (text, path, start_line, end_line) VALUES (?, ?, ?, ?)",
            (chunk["text"], rel_path, chunk["start_line"], chunk["end_line"]),
        )

    return len(chunks)


def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <db_path> <workspace_path>")
        sys.exit(1)

    db_path = sys.argv[1]
    workspace = Path(sys.argv[2])

    if not workspace.is_dir():
        print(f"Error: {workspace} is not a directory")
        sys.exit(1)

    conn = init_db(db_path)
    files = find_markdown_files(workspace)

    indexed = 0
    skipped = 0
    total_chunks = 0

    for file_path in files:
        rel_path = str(file_path.relative_to(workspace))
        file_hash = hash_file(file_path)
        file_mtime = int(file_path.stat().st_mtime)
        file_size = file_path.stat().st_size

        # Check if file has changed
        row = conn.execute(
            "SELECT hash FROM files WHERE path = ?", (rel_path,)
        ).fetchone()

        if row and row[0] == file_hash:
            skipped += 1
            continue

        # Index the file
        num_chunks = index_file(conn, rel_path, file_path)
        total_chunks += num_chunks

        # Update file record
        conn.execute(
            """INSERT OR REPLACE INTO files (path, hash, mtime, size)
               VALUES (?, ?, ?, ?)""",
            (rel_path, file_hash, file_mtime, file_size),
        )

        indexed += 1

    # Clean up files that no longer exist
    existing_paths = {str(f.relative_to(workspace)) for f in files}
    db_paths = {
        row[0] for row in conn.execute("SELECT path FROM files").fetchall()
    }
    removed_paths = db_paths - existing_paths

    for removed_path in removed_paths:
        conn.execute("DELETE FROM files WHERE path = ?", (removed_path,))
        conn.execute("DELETE FROM chunks WHERE path = ?", (removed_path,))
        conn.execute("DELETE FROM chunks_fts WHERE path = ?", (removed_path,))

    conn.commit()
    conn.close()

    print(
        f"Index complete: {indexed} indexed, {skipped} unchanged, "
        f"{len(removed_paths)} removed, {total_chunks} new chunks"
    )


if __name__ == "__main__":
    main()
