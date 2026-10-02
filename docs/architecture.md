# Goldfish — Architecture

_A Claude Code or Codex agent runtime. Two launchd agents. One config file._

---

## The Fundamental Insight

Claude Code and Codex already provide tools, session persistence, project context, and resumable conversations. Goldfish is a **thin Slack adapter** that routes a message to the selected runtime and a **memory pipeline** that captures what happens.

**The infrastructure is minimal: two launchd agents and one config file.** A runtime resolver chooses `claude` or `codex` globally, by channel, or by scheduled task. The selected provider does the orchestration; Goldfish gives it a home.

---

## System Overview

```
┌─────────────────────────────────────────────────┐
│                    SLACK                        │
│  DMs, channels, threads                         │
└──────────────┬──────────────────────────────────┘
               │ Socket Mode (WebSocket)
               ▼
┌─────────────────────────────────────────────────┐
│           SLACK BOT DAEMON                      │
│  (Node.js, long-running, ~640 lines)            │
│                                                 │
│  • Receives Slack messages                      │
│  • Maps threads → provider sessions (SQLite)    │
│  • Routes to ClaudeRunner or CodexRunner        │
│  • Posts response back to thread                │
│  • Saves transcript to memory/sessions/         │
└──────────────┬──────────────────────────────────┘
               │ spawns per message
               ▼
┌─────────────────────────────────────────────────┐
│       CLAUDE CODE OR OPENAI CODEX               │
│  (authenticated local CLI session)              │
│                                                 │
│  • Reads CLAUDE.md or AGENTS.md                 │
│  • Tools run under provider execution policy    │
│  • Memory search via sqlite3                    │
│  • Native provider session persistence          │
└──────────────┬──────────────────────────────────┘
               │ writes during + after session
               ▼
┌─────────────────────────────────────────────────┐
│           MEMORY LAYER (filesystem)             │
│                                                 │
│  memory/sessions/   ← per-session transcripts   │
│  memory/YYYY-MM-DD.md ← daily synthesis         │
│  memory/people/     ← relationship profiles     │
│  memory/projects/   ← project context           │
│  memory/topics/     ← deep dives                │
│  memory/search.sqlite ← FTS5 index              │
│  Agent identity + config files                  │
└─────────────────────────────────────────────────┘
               ▲
               │ reads + writes
┌─────────────────────────────────────────────────┐
│     SCHEDULER (cron, every minute)              │
│ Reads <workspace>/schedule.yaml, fires matching │
│ tasks                                           │
│                                                 │
│  Initiate tasks → selected runtime → Slack:     │
│  • Morning briefing (8:30 AM)                   │
│  • Hourly heartbeat — silent unless urgent      │
│  • Optional: evening exploration session        │
│                                                 │
│  Maintenance tasks (no Slack):                  │
│  • Daily synthesis (1 AM)                       │
│  • FTS5 index rebuild (1:15 AM)                 │
└─────────────────────────────────────────────────┘
```

---

## Component 1: The Slack Bot Daemon

### What It Does

Listens for Slack messages via Socket Mode. For each message it resolves a backend, provider-specific model, and effort; invokes that runner; and posts the normalized result. Slack threads map to provider sessions for continuity.

### Key Files

- **`SlackBoltClient.ts`** — Slack SDK wrapper (Socket Mode, send/update/delete messages, file upload)
- **`AgentRunner.ts`** — provider-neutral run/result contract
- **`ClaudeRunner.ts`** — Claude CLI transport
- **`CodexRunner.ts`** — Codex TypeScript SDK transport
- **`SqliteRepo.ts`** — maps Slack threads → active backend/session pairs
- **`start.ts`** — message handler, thinking indicator, session lookup, error handling
- **`slackFormatter.ts`** — markdown → Slack mrkdwn conversion

### How Threads = Parallel Conversations

Each Slack thread maps to one active provider session. Same-provider model changes can resume it; changing providers clears it and starts fresh:

```
Slack DM (new message)     → new provider session (fresh context)
Slack DM (thread reply)    → resume active provider session
Channel (new msg)          → new session, auto-threaded
Channel (thread reply)     → claude --resume <session_id>
```

The `SqliteRepo` stores the mapping:

```
slack_thread_ts  →  agent_backend + agent_session_id
1234567890.001   →  claude + a1b2c3d4-...
1234567890.002   →  codex  + 0199abcd-...
```

### Working Directory and Identity Bootstrap

The runtime starts in **the agent workspace directory**, not the Goldfish repo. Claude reads `CLAUDE.md`; Codex reads `AGENTS.md`. `GOLDFISH_WORKSPACE` selects the workspace.

---

## Component 2: Memory Pipeline

### Layer 1: In-Session Memory (Agent writes it)

If the provider identity file instructs the agent to update memory during meaningful conversations, this becomes the richest memory source.

Common memory locations:

- `memory/YYYY-MM-DD.md` — daily narrative
- `memory/topics/` — deep dives
- `memory/people/` — contact profiles
- `memory/projects/` — project context
- `memory/decisions/` — decision records

### Layer 2: Post-Session Transcript (The Slack Bot saves it)

Every message exchange gets appended to `memory/sessions/YYYY-MM-DD.jsonl`. This is mechanical, not creative — just a log of what was said. The bot does this automatically.

### Layer 3: Daily Synthesis

At 1 AM, `scripts/daily-synthesis.sh`:

1. Reads yesterday's session JSONL
2. Reads any memory files the agent wrote during the day
3. Invokes the configured synthesis backend through the provider-neutral runner
4. Writes to `memory/YYYY-MM-DD.md` (additive — doesn't overwrite what the agent already wrote)

Synthesis inherits `GOLDFISH_BACKEND` unless the schedule task supplies `backend`. Claude synthesis defaults to `claude-sonnet-4-6` so changing the interactive Claude model does not silently change maintenance cost; Codex synthesis inherits `GOLDFISH_CODEX_MODEL`. A task-level `model` or `effort` overrides either provider. Synthesis runs isolated, read-only, without workspace identity discovery, command network, or web search.

### Layer 4: FTS5 Search Index

`src/lib/memoryIndexer.ts` walks all markdown/JSONL files and builds the search index. FTS5 keyword indexing is pure text processing — no API calls, no cost. When a local embedding model is installed (`goldfish embeddings setup`), it *additionally* builds sqlite-vec vectors (nomic-embed-text-v1.5, 768-dim, local) so `goldfish search` can fuse keyword + semantic results. Vectors are additive — with no model, the index stays FTS-only.

1. Walks `memory/`, identity files, config files
2. Chunks by markdown heading or ~500-word blocks
3. Hashes each file — skips unchanged files on re-index (but still backfills missing vectors)
4. Upserts chunks into the FTS5 virtual table and, when enabled, the `chunks_vec` table

Query:

```bash
sqlite3 memory/search.sqlite \
  "SELECT path, snippet(chunks_fts, 0, '>>>', '<<<', '...', 40) \
   FROM chunks_fts WHERE chunks_fts MATCH 'search terms' \
   ORDER BY rank LIMIT 10;"
```

---

## Component 3: The Scheduler

All scheduled tasks are defined in `schedule.yaml` inside the user workspace and driven by a launchd agent (`com.jdlien.goldfish.scheduler`) that fires every 60 seconds.

The scheduler loads the config, checks which tasks are due, and fires them. Lock files prevent overlapping runs of the same task. There are two categories:

**Initiate tasks** invoke the selected runtime and post results to Slack:

| Type          | Default Schedule   | Purpose                                                |
| ------------- | ------------------ | ------------------------------------------------------ |
| `morning`     | 8:30 AM weekdays   | Morning briefing — reads FOCUS.md, suggests priorities |
| `heartbeat`   | Hourly, work hours | Silent check; pings only on urgent items               |
| `exploration` | 6:00 PM daily      | Agent picks a topic and writes a deep dive             |
| `weekly`      | Sunday 9 AM        | Weekly review                                          |

**Maintenance tasks** run system operations (no Slack):

| Type              | Default Schedule | Purpose                             |
| ----------------- | ---------------- | ----------------------------------- |
| `daily-synthesis` | 1:00 AM          | Consolidate transcripts → daily log |
| `index-memory`    | 1:15 AM          | Rebuild FTS5 search index           |

All timing, channels, and models are configurable per-task. See [`scheduling.md`](scheduling.md) for the full reference.

---

## Component 4: Browser (Patchright)

Goldfish supports a stealth Chromium browser via Patchright (a Playwright fork with bot-detection patches). This gives the agent access to authenticated web browsing — login once manually, and headless runs reuse the session cookies.

To install the necessary binaries, run:
```bash
npx patchright install chromium
```

- **Profile:** `~/Library/Application Support/goldfish/browser-profile` (persistent cookies, lockfile-serialized)
- **CLI:** `goldfish browser login` (headful, for manual auth), `goldfish browser goto <url>` (headless)
- **Code:** `withBrowser(async (ctx) => { ... })` for programmatic use
