/**
 * Goldfish configuration
 *
 * Central place for paths and settings. Reads from environment
 * with sensible defaults for macOS.
 */

import { delimiter, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import type { AgentBackend, AgentWebSearchMode } from './adapters/AgentRunner.js';

function recordEnv(name: string): Record<string, string> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

function backendEnv(raw: string | undefined, fallback: AgentBackend): AgentBackend {
  return raw === 'codex' || raw === 'claude' ? raw : fallback;
}

/** The agent workspace — where identity files, memory, and tools live */
export const WORKSPACE_PATH =
  process.env.GOLDFISH_WORKSPACE ?? join(homedir(), 'goldfish-workspace');

/** Session transcript output directory */
export const SESSIONS_PATH =
  process.env.GOLDFISH_SESSIONS_PATH ?? join(WORKSPACE_PATH, 'memory', 'sessions');

/**
 * Read a numeric env var, falling back when unset *or empty*.
 *
 * `Number('')` is 0, not NaN — so an env var set to the empty string would
 * silently make every duration cap below read as "zero milliseconds allowed",
 * i.e. every voice note rejected as too long. These are the knobs most likely
 * to be hand-edited, so they don't get the bare `Number(x ?? y)` pattern used
 * elsewhere in this file.
 */
function numEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Where downloaded Slack file attachments are stored */
export const ATTACHMENTS_PATH =
  process.env.GOLDFISH_ATTACHMENTS_PATH ?? join(WORKSPACE_PATH, 'memory', 'attachments');

/**
 * Maximum file size for Slack attachment downloads (bytes, default 50 MB).
 *
 * Raised from 20 MB on 2026-09-17: Don sent a 33 MB scanned lease PDF and it
 * was refused before download. His scans are image-only with no text layer, so
 * they are large by nature and more of them will arrive. Slack's own upload
 * ceiling is far higher, so this number is entirely our choice — and the file
 * is buffered in memory once, which 50 MB is nothing for.
 */
export const MAX_FILE_SIZE_BYTES = numEnv(
  process.env.GOLDFISH_MAX_FILE_BYTES,
  50 * 1024 * 1024,
);

/** Max attachments processed per message */
export const MAX_ATTACHMENTS_PER_MESSAGE = numEnv(
  process.env.GOLDFISH_MAX_ATTACHMENTS,
  10,
);


/**
 * MacWhisper CLI, used to transcribe Slack voice messages.
 *
 * MUST be absolute. The daemon is a LaunchAgent whose PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin` — `/usr/local/bin` is not on it, and a bare
 * `mw` fails with ENOENT. (`/usr/bin/afinfo` below *is* on that PATH.)
 */
export const MW_BIN_PATH = process.env.GOLDFISH_MW_PATH ?? '/usr/local/bin/mw';

/**
 * Transcription model, pinned.
 *
 * `mw` defaults every one of its flags to whatever MacWhisper's GUI currently
 * has selected. Left unpinned, opening the app to run a podcast on large-v3
 * with diarization would silently repoint every voice note at a 5-10x slower
 * model and start returning `Speaker 1:`-prefixed transcripts, with nothing in
 * the daemon changed and nothing in the logs to explain it.
 *
 * IDs come from `mw models list`.
 */
export const MW_MODEL =
  process.env.GOLDFISH_MW_MODEL ?? 'parakeet-pro:nvidia_parakeet-v3_494MB';

/** Source language. 'auto' misdetects on short clips, so default to explicit. */
export const TRANSCRIBE_LANGUAGE = process.env.GOLDFISH_TRANSCRIBE_LANG ?? 'en';

/** Longest single audio file we'll transcribe (ms). */
export const MAX_TRANSCRIBE_DURATION_MS = numEnv(
  process.env.GOLDFISH_MAX_TRANSCRIBE_MS,
  10 * 60 * 1000,
);

/**
 * Longest *total* audio per message (ms).
 *
 * Not optional. Transcription is synchronous inside the per-session lock, and
 * MAX_ATTACHMENTS_PER_MESSAGE is 10 — so a per-file cap alone would permit
 * ~100 minutes of audio in one message, from any full workspace member.
 */
export const MAX_TRANSCRIBE_TOTAL_DURATION_MS = numEnv(
  process.env.GOLDFISH_MAX_TRANSCRIBE_TOTAL_MS,
  15 * 60 * 1000,
);

/**
 * PDF OCR toolchain. ALL ABSOLUTE.
 *
 * Read off the live daemon with `ps eww`, its PATH is the fnm node bin plus a
 * few odds and ends — it contains NEITHER /opt/homebrew/bin NOR /usr/local/bin,
 * because launchd starts it with a minimal PATH. A bare `ocrmypdf` is ENOENT.
 * Same trap as MW_BIN_PATH above, which has now cost two separate incidents.
 */
export const PDFTOTEXT_BIN_PATH =
  process.env.GOLDFISH_PDFTOTEXT_PATH ?? '/opt/homebrew/bin/pdftotext';
export const QPDF_BIN_PATH =
  process.env.GOLDFISH_QPDF_PATH ?? '/opt/homebrew/bin/qpdf';
export const OCRMYPDF_BIN_PATH =
  process.env.GOLDFISH_OCRMYPDF_PATH ?? '/opt/homebrew/bin/ocrmypdf';

/**
 * Longest scanned PDF we'll OCR inline.
 *
 * Measured 28.8s for 58 pages at --jobs 8. OCR runs inside the per-session
 * lock, so this is a wall-clock budget wearing a page count — 120 pages is
 * roughly a minute of someone waiting for a reply.
 */
export const MAX_OCR_PAGES = numEnv(process.env.GOLDFISH_MAX_OCR_PAGES, 120);

/** Parallel OCR workers. The host is a 12-core M2 Max someone else is using. */
export const OCR_JOBS = numEnv(process.env.GOLDFISH_OCR_JOBS, 8);


/** Memory search database */
export const SEARCH_DB_PATH =
  process.env.GOLDFISH_SEARCH_DB ?? join(WORKSPACE_PATH, 'memory', 'search.sqlite');

/**
 * Semantic (vector) memory search configuration.
 *
 * Embeddings turn chunk text → 768-dim vectors locally via node-llama-cpp +
 * the nomic GGUF. The model is fetched at setup time (see `goldfish embeddings
 * setup`), never vendored into the repo or downloaded silently at 1:15am.
 */

/** Hugging Face URI for the embedding model. */
export const EMBEDDING_MODEL_URI =
  process.env.GOLDFISH_EMBEDDING_MODEL_URI ??
  'hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q8_0.gguf';

/** Directory holding the pulled GGUF — outside both the repo and workspace git. */
export const EMBEDDING_MODEL_DIR =
  process.env.GOLDFISH_EMBEDDING_MODEL_DIR ??
  join(homedir(), 'Library', 'Application Support', 'goldfish', 'models');

/** Embedding dimensionality (nomic-embed-text-v1.5 → 768). */
export const EMBEDDING_DIMS = Number(process.env.GOLDFISH_EMBEDDING_DIMS ?? 768);

/**
 * Vector-memory mode:
 *  - `off`:      FTS only; never load the model or vector tables.
 *  - `auto`:     use vectors when sqlite-vec + model are available, else warn and
 *                fall back to a valid FTS-only index (default).
 *  - `required`: fail loudly if vectors cannot run.
 */
export type MemoryVectorsMode = 'off' | 'auto' | 'required';
export const MEMORY_VECTORS_MODE: MemoryVectorsMode = (() => {
  const raw = (process.env.GOLDFISH_MEMORY_VECTORS ?? 'auto').toLowerCase();
  return raw === 'off' || raw === 'required' ? raw : 'auto';
})();

/** Structured runtime diagnostics that should stay outside the source repo */
export const DIAGNOSTICS_PATH =
  process.env.GOLDFISH_DIAGNOSTICS_PATH ??
  join(WORKSPACE_PATH, 'diagnostics', 'native-stream-failures.jsonl');

/** Default max turns for Claude Code (allow substantial agentic work) */
export const DEFAULT_MAX_TURNS = Number(process.env.GOLDFISH_MAX_TURNS ?? 50);

/** Default timeout for Claude Code invocations (ms) */
export const DEFAULT_TIMEOUT_MS = Number(process.env.GOLDFISH_TIMEOUT_MS ?? 900_000);

/** Runtime provider. Claude remains the upgrade-safe default. */
export const DEFAULT_BACKEND: AgentBackend = backendEnv(
  process.env.GOLDFISH_BACKEND,
  'claude',
);
export const BACKEND_BY_CHANNEL = recordEnv('GOLDFISH_BACKEND_BY_CHANNEL');

/** Executable and unattended execution policy for Codex. */
// Leave this undefined to let @openai/codex-sdk use its pinned bundled CLI.
// Set it only when deliberately testing or deploying a different executable.
export const CODEX_PATH = process.env.GOLDFISH_CODEX_PATH || undefined;
export const CLAUDE_PATH = process.env.GOLDFISH_CLAUDE_PATH ?? 'claude';
export const CODEX_SANDBOX = (() => {
  const value = process.env.GOLDFISH_CODEX_SANDBOX;
  return value === 'read-only' || value === 'danger-full-access' || value === 'workspace-write'
    ? value
    : 'workspace-write';
})();
// Goldfish agents invoke network-backed workspace tools (including Slack), so
// command network is enabled by default. Web search remains a separate control.
export const CODEX_NETWORK = process.env.GOLDFISH_CODEX_NETWORK !== 'false';
export const CODEX_WEB_SEARCH: AgentWebSearchMode = (() => {
  const value = process.env.GOLDFISH_CODEX_WEB_SEARCH;
  return value === 'disabled' || value === 'live' || value === 'cached'
    ? value
    : 'cached';
})();
export const CODEX_ADDITIONAL_DIRECTORIES = (
  process.env.GOLDFISH_CODEX_ADDITIONAL_DIRECTORIES ?? ''
)
  .split(delimiter)
  .map((value) => value.trim())
  .filter(Boolean);

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

/**
 * Buffer size (chars) for Slack's native ChatStreamer. Controls how many
 * chars the SDK accumulates before making an appendStream API call.
 *
 * Note: Slack's client-side streaming renderer has cosmetic bugs (missing
 * spaces, spurious newlines) regardless of buffer size — confirmed Apr 2026.
 * This setting is kept configurable for future experimentation.
 *
 * Default: 1024. Slack SDK default is 256.
 * Set `GOLDFISH_STREAM_BUFFER_SIZE` to tune.
 */
export const STREAM_BUFFER_SIZE = Number(
  process.env.GOLDFISH_STREAM_BUFFER_SIZE ?? 1024
);

/** Effort levels the Claude CLI accepts (anything else is ignored by the CLI). */
export const ALL_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CODEX_EFFORT_LEVELS = ALL_EFFORT_LEVELS;
/** @deprecated Use the provider-specific effort list where possible. */
export const VALID_EFFORT_LEVELS = ALL_EFFORT_LEVELS;

/**
 * Default thinking effort applied to every session unless a channel overrides it.
 * Unset → omit the flag entirely and let the CLI use its own default.
 * Set `GOLDFISH_EFFORT` to one of: low | medium | high | xhigh | max.
 */
export const DEFAULT_EFFORT = process.env.GOLDFISH_EFFORT;

/**
 * Per-channel effort overrides. JSON map of Slack channel ID → effort level, e.g.
 * `GOLDFISH_EFFORT_BY_CHANNEL='{"C0A7VB1U6EA":"low"}'`.
 * Lets chatty channels run fast (low) while work channels stay sharp (high/max).
 */
export const EFFORT_BY_CHANNEL = recordEnv('GOLDFISH_EFFORT_BY_CHANNEL');

/**
 * Per-channel briefing text. JSON map of Slack channel ID -> a short note
 * injected at the top of every prompt in that channel, e.g.
 * `GOLDFISH_CHANNEL_BRIEF='{"C0123456789":"Shared channel with an external collaborator..."}'`.
 *
 * Why this exists: a Slack message arrives as bare text with no author and no
 * room attached. In a channel containing someone other than the owner, the
 * agent has no way to know who it is talking to, and defaults to assuming it
 * is the owner. That default leaked private context on 2026-09-17.
 */
export const CHANNEL_BRIEF: Record<string, string> = (() => {
  const raw = process.env.GOLDFISH_CHANNEL_BRIEF;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
})();

/**
 * Slack user ID of the workspace owner. Used to decide whether a DM needs a
 * sender header: a DM from anyone else is not the person the agent's identity
 * files are written about. Unset -> DMs are never annotated (legacy behaviour).
 */
export const OWNER_USER_ID = process.env.GOLDFISH_OWNER_USER_ID;

export function briefForChannel(channelId: string | undefined): string | undefined {
  return channelId ? CHANNEL_BRIEF[channelId] : undefined;
}

/**
 * Default model applied to every session unless a channel overrides it.
 * Unset → omit the flag entirely and let the CLI use its own default.
 * Set `GOLDFISH_MODEL` to any model the CLI accepts (alias like `opus`,
 * `sonnet`, `haiku`, `fable`, or a full model ID).
 */
export const DEFAULT_MODEL = process.env.GOLDFISH_MODEL;
export const DEFAULT_CLAUDE_MODEL =
  process.env.GOLDFISH_CLAUDE_MODEL ?? DEFAULT_MODEL;
export const DEFAULT_CODEX_MODEL = process.env.GOLDFISH_CODEX_MODEL;

/**
 * Per-channel model overrides. JSON map of Slack channel ID → model, e.g.
 * `GOLDFISH_MODEL_BY_CHANNEL='{"C0A7VB1U6EA":"haiku"}'`.
 * Lets chatty channels run cheap while work channels get the big brain.
 * No validation list here — model names churn too fast; an invalid value
 * surfaces as a CLI error rather than being silently dropped.
 */
export const MODEL_BY_CHANNEL = recordEnv('GOLDFISH_MODEL_BY_CHANNEL');
export const CLAUDE_MODEL_BY_CHANNEL = {
  ...MODEL_BY_CHANNEL,
  ...recordEnv('GOLDFISH_CLAUDE_MODEL_BY_CHANNEL'),
};
export const CODEX_MODEL_BY_CHANNEL = recordEnv('GOLDFISH_CODEX_MODEL_BY_CHANNEL');

/**
 * Resolve the model for a given channel. Channel override wins over the
 * global default. Returns `undefined` (omit the flag) when nothing is
 * configured.
 */
export function modelForChannel(channelId: string | undefined): string | undefined {
  return modelForBackendChannel('claude', channelId);
}

export function backendForChannel(channelId: string | undefined): AgentBackend {
  return backendEnv(channelId ? BACKEND_BY_CHANNEL[channelId] : undefined, DEFAULT_BACKEND);
}

export function modelForBackendChannel(
  backend: AgentBackend,
  channelId: string | undefined,
): string | undefined {
  if (backend === 'codex') {
    return (channelId ? CODEX_MODEL_BY_CHANNEL[channelId] : undefined) ?? DEFAULT_CODEX_MODEL;
  }
  return (channelId ? CLAUDE_MODEL_BY_CHANNEL[channelId] : undefined) ?? DEFAULT_CLAUDE_MODEL;
}

export interface ResolvedRuntime {
  backend: AgentBackend;
  model?: string;
  effort?: string;
}

export function runtimeForChannel(
  channelId: string | undefined,
  overrides: Partial<ResolvedRuntime> = {},
): ResolvedRuntime {
  const backend = overrides.backend ?? backendForChannel(channelId);
  return {
    backend,
    model: overrides.model ?? modelForBackendChannel(backend, channelId),
    effort: overrides.effort ?? effortForBackendChannel(backend, channelId),
  };
}

/**
 * Resolve an interactive thread's runtime. A scheduled task with an explicit
 * backend override pins its newly-created Slack thread to that backend so the
 * user's replies can resume the session it advertised. Ordinary threads keep
 * following channel/global configuration changes.
 */
export function runtimeForConversation(
  channelId: string | undefined,
  session: { agentBackend: AgentBackend | null; agentBackendPinned: boolean },
): ResolvedRuntime {
  return runtimeForChannel(
    channelId,
    session.agentBackendPinned && session.agentBackend
      ? { backend: session.agentBackend }
      : {},
  );
}

/** Deterministic startup validation for routing and execution-policy settings. */
export function validateConfiguration(): string[] {
  const errors: string[] = [];
  const backend = process.env.GOLDFISH_BACKEND;
  if (backend && backend !== 'claude' && backend !== 'codex') {
    errors.push(`GOLDFISH_BACKEND must be "claude" or "codex" (received "${backend}").`);
  }
  const sandbox = process.env.GOLDFISH_CODEX_SANDBOX;
  if (sandbox && !['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
    errors.push(`GOLDFISH_CODEX_SANDBOX has invalid value "${sandbox}".`);
  }
  const webSearch = process.env.GOLDFISH_CODEX_WEB_SEARCH;
  if (webSearch && !['disabled', 'cached', 'live'].includes(webSearch)) {
    errors.push(`GOLDFISH_CODEX_WEB_SEARCH has invalid value "${webSearch}".`);
  }

  const recordNames = [
    'GOLDFISH_BACKEND_BY_CHANNEL',
    'GOLDFISH_EFFORT_BY_CHANNEL',
    'GOLDFISH_MODEL_BY_CHANNEL',
    'GOLDFISH_CLAUDE_MODEL_BY_CHANNEL',
    'GOLDFISH_CODEX_MODEL_BY_CHANNEL',
  ];
  for (const name of recordNames) {
    const raw = process.env[name];
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push(`${name} must be a JSON object.`);
      }
    } catch {
      errors.push(`${name} contains invalid JSON.`);
    }
  }

  for (const [channel, value] of Object.entries(BACKEND_BY_CHANNEL)) {
    if (value !== 'claude' && value !== 'codex') {
      errors.push(`GOLDFISH_BACKEND_BY_CHANNEL[${channel}] must be "claude" or "codex".`);
    }
  }
  if (DEFAULT_EFFORT) {
    const valid = DEFAULT_BACKEND === 'claude' ? CLAUDE_EFFORT_LEVELS : CODEX_EFFORT_LEVELS;
    if (!valid.includes(DEFAULT_EFFORT)) {
      errors.push(`GOLDFISH_EFFORT "${DEFAULT_EFFORT}" is not valid for ${DEFAULT_BACKEND}.`);
    }
  }
  for (const [channel, backendValue] of Object.entries(BACKEND_BY_CHANNEL)) {
    if (!DEFAULT_EFFORT || EFFORT_BY_CHANNEL[channel]) continue;
    if (backendValue !== 'claude' && backendValue !== 'codex') continue;
    const valid = backendValue === 'claude' ? CLAUDE_EFFORT_LEVELS : CODEX_EFFORT_LEVELS;
    if (!valid.includes(DEFAULT_EFFORT)) {
      errors.push(
        `GOLDFISH_EFFORT "${DEFAULT_EFFORT}" is not valid for ${backendValue} channel ${channel}.`,
      );
    }
  }
  for (const [channel, effort] of Object.entries(EFFORT_BY_CHANNEL)) {
    const channelBackend = backendForChannel(channel);
    const valid = channelBackend === 'claude' ? CLAUDE_EFFORT_LEVELS : CODEX_EFFORT_LEVELS;
    if (!valid.includes(effort)) {
      errors.push(`GOLDFISH_EFFORT_BY_CHANNEL[${channel}] "${effort}" is not valid for ${channelBackend}.`);
    }
  }
  return errors;
}

/**
 * Resolve the effort level for a given channel. Channel override wins over the
 * global default. Returns `undefined` (omit the flag) when nothing is configured
 * or the configured value isn't a valid level — so a typo degrades to CLI default
 * rather than silently doing something surprising.
 */
export function effortForChannel(channelId: string | undefined): string | undefined {
  const candidate =
    (channelId ? EFFORT_BY_CHANNEL[channelId] : undefined) ?? DEFAULT_EFFORT;
  return candidate && ALL_EFFORT_LEVELS.includes(candidate)
    ? candidate
    : undefined;
}

export function effortForBackendChannel(
  backend: AgentBackend,
  channelId: string | undefined,
): string | undefined {
  const effort = effortForChannel(channelId);
  const valid = backend === 'claude' ? CLAUDE_EFFORT_LEVELS : CODEX_EFFORT_LEVELS;
  return effort && valid.includes(effort) ? effort : undefined;
}

/**
 * Validate that the workspace directory exists and contains a CLAUDE.md.
 * Call this at the start of commands that need the workspace (start, initiate).
 * Returns null if valid, or an error message string.
 */
export function validateWorkspace(backend: AgentBackend = DEFAULT_BACKEND): string | null {
  if (!existsSync(WORKSPACE_PATH)) {
    return [
      `Workspace directory not found: ${WORKSPACE_PATH}`,
      '',
      'To fix this, either:',
      '  1. Run: goldfish init        (creates a workspace from the starter template)',
      '  2. Set GOLDFISH_WORKSPACE in your .env to an existing directory',
      '',
      'See SETUP.md for the full setup guide.',
    ].join('\n');
  }

  const identityFile = backend === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  if (!existsSync(join(WORKSPACE_PATH, identityFile))) {
    return [
      `Workspace exists but is missing ${identityFile}: ${WORKSPACE_PATH}`,
      '',
      `${identityFile} defines your ${backend} agent's identity and is required.`,
      `Run: goldfish init    (to scaffold a workspace with a starter ${identityFile})`,
    ].join('\n');
  }

  return null;
}

/** Non-fatal identity mismatches that can make a provider boot incompletely. */
export function workspaceWarnings(backend: AgentBackend = DEFAULT_BACKEND): string[] {
  if (backend !== 'codex') return [];
  const claudePath = join(WORKSPACE_PATH, 'CLAUDE.md');
  const agentsPath = join(WORKSPACE_PATH, 'AGENTS.md');
  if (!existsSync(claudePath) || !existsSync(agentsPath)) return [];

  const claude = readFileSync(claudePath, 'utf8');
  const agents = readFileSync(agentsPath, 'utf8');
  const imports = new Set(
    [...claude.matchAll(/@([A-Za-z0-9_./-]+\.md)\b/g)].map((match) => match[1]),
  );
  const missing = [...imports].filter((target) => !agents.includes(target));
  return missing.length > 0
    ? [
        `AGENTS.md does not mention Claude identity imports: ${missing.join(', ')}. ` +
          'Codex does not expand @file syntax; add explicit instructions to read these files.',
      ]
    : [];
}
