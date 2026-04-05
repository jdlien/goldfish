/**
 * Goldfish configuration
 *
 * Central place for paths and settings. Reads from environment
 * with sensible defaults for macOS.
 */

import { join } from 'path';
import { homedir } from 'os';

/** The agent workspace — where identity files, memory, and tools live */
export const WORKSPACE_PATH =
  process.env.GOLDFISH_WORKSPACE ?? join(homedir(), 'goldfish-workspace');

/** Session transcript output directory */
export const SESSIONS_PATH =
  process.env.GOLDFISH_SESSIONS_PATH ?? join(WORKSPACE_PATH, 'memory', 'sessions');

/** Where downloaded Slack file attachments are stored */
export const ATTACHMENTS_PATH =
  process.env.GOLDFISH_ATTACHMENTS_PATH ?? join(WORKSPACE_PATH, 'memory', 'attachments');

/** Maximum file size for Slack attachment downloads (bytes, default 20 MB) */
export const MAX_FILE_SIZE_BYTES = Number(
  process.env.GOLDFISH_MAX_FILE_BYTES ?? 20 * 1024 * 1024,
);

/** Max attachments processed per message */
export const MAX_ATTACHMENTS_PER_MESSAGE = Number(
  process.env.GOLDFISH_MAX_ATTACHMENTS ?? 10,
);

/** Memory search database */
export const SEARCH_DB_PATH =
  process.env.GOLDFISH_SEARCH_DB ?? join(WORKSPACE_PATH, 'memory', 'search.sqlite');

/** Default max turns for Claude Code (allow substantial agentic work) */
export const DEFAULT_MAX_TURNS = Number(process.env.GOLDFISH_MAX_TURNS ?? 50);

/** Default timeout for Claude Code invocations (ms) */
export const DEFAULT_TIMEOUT_MS = Number(process.env.GOLDFISH_TIMEOUT_MS ?? 900_000);

/** Session expiry — start fresh if thread is older than this (ms) */
export const SESSION_EXPIRY_MS = Number(
  process.env.GOLDFISH_SESSION_EXPIRY_MS ?? 48 * 60 * 60 * 1000 // 48 hours
);

/** Enable streaming responses (progressive Slack updates) */
export const STREAMING_ENABLED = process.env.GOLDFISH_STREAMING !== 'false';

/**
 * Use Slack's native streaming API (chat.startStream / appendStream / stopStream)
 * instead of the custom chat.update-based streamer. Gives us native markdown
 * rendering including tables. Only effective when STREAMING_ENABLED is true.
 */
export const NATIVE_STREAMING_ENABLED =
  process.env.GOLDFISH_NATIVE_STREAMING !== 'false';

/** How often to update the Slack message during streaming (ms) */
export const STREAM_UPDATE_INTERVAL_MS = Number(
  process.env.GOLDFISH_STREAM_INTERVAL_MS ?? 1500
);

/**
 * Show tool calls in Slack's native task timeline (the "thinking…" boxes
 * that appear above streamed text showing which tools Claude is using).
 *
 * Default: true. Set `GOLDFISH_SHOW_TOOLS=false` to suppress them for a
 * cleaner scrollback — assistant text still streams normally, only the
 * per-tool timeline chunks are skipped.
 */
export const SHOW_TOOLS = process.env.GOLDFISH_SHOW_TOOLS !== 'false';
