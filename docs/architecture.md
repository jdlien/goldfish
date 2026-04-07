# Goldfish — Architecture

_A Claude Code-native agent runtime. One daemon, one cron entry._

---

## The Fundamental Insight

OpenClaw is an orchestration layer that routes messages to models like Claude. But Claude Code already _is_ an orchestration layer — it has tools, hooks, session persistence, project context, and `--resume`. We don't need to build an agent runtime from scratch. We need a **thin Slack adapter** that gets messages to Claude Code and a **memory pipeline** that captures what happens.

**The infrastructure is minimal: one daemon, one cron entry, one config file.** The depth is in what sits on top — session continuity across threads, a four-layer memory pipeline with full-text search, proactive outreach, browser automation, and a CLI for everything else. Claude Code does the orchestration; Goldfish gives it a home.

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
│  (Node.js, long-running, ~640 lines)             │
│                                                 │
│  • Receives Slack messages                      │
│  • Maps threads → Claude sessions (SQLite)      │
│  • Spawns: claude -p "msg" --resume <id>        │
│  • Posts response back to thread                │
│  • Saves transcript to memory/sessions/         │
└──────────────┬──────────────────────────────────┘
               │ spawns per message
               ▼
┌─────────────────────────────────────────────────┐
│           CLAUDE CODE (CLI)                     │
│  (Max subscription, $0 marginal cost)           │
│                                                 │
│  • Reads CLAUDE.md → agent identity/config      │
│  • Full tool access (bash, edit, read, web)     │
│  • Memory search via sqlite3                    │
│  • Session persistence via --resume             │
│  • Hooks fire on session events                 │
│  • --dangerously-skip-permissions for headless  │
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
│     Reads schedule.yaml, fires matching tasks   │
│                                                 │
│  Initiate tasks → Claude → Slack:               │
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

Listens for Slack messages via Socket Mode. When a message arrives, spawns a `claude` CLI process with the message as prompt. Posts the response back. Maps Slack threads to Claude sessions for continuity.

### Key Files

- **`SlackBoltClient.ts`** — Slack SDK wrapper (Socket Mode, send/update/delete messages, file upload)
- **`ClaudeRunner.ts`** — spawns `claude -p` with JSON output, handles `--resume`, timeouts
- **`SqliteRepo.ts`** — maps Slack threads → Claude session IDs
- **`start.ts`** — message handler, thinking indicator, session lookup, error handling
- **`slackFormatter.ts`** — markdown → Slack mrkdwn conversion

### How Threads = Parallel Conversations

Each Slack thread maps to an independent Claude Code session:

```
Slack DM (new message)     → new Claude session (fresh context)
Slack DM (thread reply)    → claude --resume <session_id> (continues)
Channel (new msg)          → new session, auto-threaded
Channel (thread reply)     → claude --resume <session_id>
```

The `SqliteRepo` stores the mapping:

```
slack_thread_ts  →  claude_session_id
1234567890.001   →  a1b2c3d4-...
1234567890.002   →  e5f6g7h8-...
```

### CWD and Identity Bootstrap

Claude Code spawns in **the agent workspace directory**, not the goldfish repo. This means `CLAUDE.md` at workspace root bootstraps the agent's identity. Configurable via the `GOLDFISH_WORKSPACE` environment variable (defaults to `~/goldfish-workspace`).

---

## Component 2: Memory Pipeline

### Layer 1: In-Session Memory (Agent writes it)

If the agent's `CLAUDE.md` instructs it to update memory files during meaningful conversations, this becomes the richest memory source. No automation needed — the agent does this naturally when the conversation warrants it.

Common memory locations:

- `memory/YYYY-MM-DD.md` — daily narrative
- `memory/topics/` — deep dives
- `memory/people/` — contact profiles
- `memory/projects/` — project context
- `memory/decisions/` — decision records

### Layer 2: Post-Session Transcript (The Slack Bot saves it)

Every message exchange gets appended to `memory/sessions/YYYY-MM-DD.jsonl`. This is mechanical, not creative — just a log of what was said. The bot does this automatically.

### Layer 3: Daily Synthesis (Cron, Sonnet)

At 1 AM, `scripts/daily-synthesis.sh`:

1. Reads yesterday's session JSONL
2. Reads any memory files the agent wrote during the day
3. Spawns `claude` with Sonnet to produce a consolidated daily narrative
4. Writes to `memory/YYYY-MM-DD.md` (additive — doesn't overwrite what the agent already wrote)

**Model choice:** Sonnet is the default — it's the quality floor for accurate memory consolidation (smaller models may editorialize, omit details, or misinterpret tone). But if you're on a Max subscription, use Opus. Synthesis runs at 1 AM when your quota is idle, and the difference in quality is real — especially for emotionally nuanced or multi-topic days. Set `model: claude-opus-4-6` on the `daily-synthesis` task in `schedule.yaml`.

### Layer 4: FTS5 Search Index

`src/lib/memoryIndexer.ts` walks all markdown files and builds a full-text search index. Pure text processing — no API calls, no embeddings, no cost.

1. Walks `memory/`, identity files, config files
2. Chunks by markdown heading or ~500-word blocks
3. Hashes each file — skips unchanged files on re-index
4. Upserts chunks into FTS5 virtual table

Query:

```bash
sqlite3 memory/search.sqlite \
  "SELECT path, snippet(chunks_fts, 0, '>>>', '<<<', '...', 40) \
   FROM chunks_fts WHERE chunks_fts MATCH 'search terms' \
   ORDER BY rank LIMIT 10;"
```

---

## Component 3: The Scheduler

All scheduled tasks are defined in `schedule.yaml` and driven by a single cron entry that runs every minute:

```
* * * * * cd /path/to/goldfish && node dist/index.js schedule run
```

The scheduler loads the config, checks which tasks are due, and fires them. Lock files prevent overlapping runs of the same task. There are two categories:

**Initiate tasks** spawn Claude and post results to Slack:

| Type | Default Schedule | Purpose |
|------|-----------------|---------|
| `morning` | 8:30 AM weekdays | Morning briefing — reads FOCUS.md, checks tools, suggests priorities |
| `heartbeat` | Hourly, work hours | Silent check; pings only on urgent items |
| `exploration` | 6:00 PM daily | Agent picks a topic and writes a deep dive |
| `weekly` | Sunday 9 AM | Weekly review |

**Maintenance tasks** run system operations (no Slack):

| Type | Default Schedule | Purpose |
|------|-----------------|---------|
| `daily-synthesis` | 1:00 AM | Consolidate transcripts → daily log |
| `index-memory` | 1:15 AM | Rebuild FTS5 search index |

All timing, channels, and models are configurable per-task. See [`scheduling.md`](scheduling.md) for the full reference.

---

## Component 4: Browser (Patchright)

Goldfish includes a stealth Chromium browser via Patchright (a Playwright fork with bot-detection patches). This gives the agent access to authenticated web browsing — login once manually, and headless runs reuse the session cookies.

- **Profile:** `~/Library/Application Support/goldfish/browser-profile` (persistent cookies, lockfile-serialized)
- **CLI:** `goldfish browser login` (headful, for manual auth), `goldfish browser goto <url>` (headless)
- **Code:** `withBrowser(async (ctx) => { ... })` for programmatic use

---

## Cost Analysis

| Component | Cost |
|-----------|------|
| Conversations | $0 (Claude Code on Max subscription) |
| Daily synthesis | ~$0.10/day (Sonnet default, configurable) ≈ $3/mo |
| Morning briefings | $0 (Max subscription) |
| Heartbeats | $0 (Max subscription) |
| FTS5 indexing | $0 (TypeScript, no API) |
| **Total** | **Max subscription + ~$3-5/mo** |

---

_Architecture designed April 2026._
