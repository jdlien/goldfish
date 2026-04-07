# Goldfish — Developer Guide

AI agent runtime: a Slack bot that spawns Claude Code sessions per message, with thread-based session continuity and a persistent memory pipeline.

## Quick Start

```bash
pnpm install
cp .env.example .env       # Fill in Slack tokens + GOLDFISH_WORKSPACE
pnpm run cli auth test     # Verify Slack connection + Claude CLI
pnpm run cli start         # Run in dev mode (tsx, no build needed)
```

For production: `pnpm run build && node dist/index.js start` (or use launchd — see `docs/deployment-macos.md`).

## Commands

```bash
pnpm run cli start                              # Start bot (dev, tsx)
pnpm run cli auth test                          # Test Slack + Claude
pnpm run cli send -m "Hello" -c <channel>       # Send a message
pnpm run cli upload -f file.pdf -c <channel>    # Upload a file
pnpm run cli initiate -t morning                # Trigger morning briefing
pnpm run cli initiate -t morning --dry-run      # Preview briefing prompt
pnpm run build                                  # Compile TypeScript to dist/
pnpm run test                                   # Run tests (vitest)
```

## Architecture

```
src/
├── index.ts                    # CLI entry (Commander)
├── config.ts                   # Env vars + defaults
├── cli/
│   ├── start.ts                # Bot daemon — message handler, session management
│   ├── auth.ts                 # Token status/test
│   ├── send.ts                 # Manual message sending
│   ├── upload.ts               # File upload
│   ├── initiate.ts             # Proactive outreach (briefings, reminders)
│   ├── maintenance.ts          # Scheduled maintenance (synthesis, indexing)
│   └── schedule.ts             # Schedule runner (reads schedule.yaml)
├── adapters/
│   ├── SlackBoltClient.ts      # Slack Bolt SDK wrapper (Socket Mode)
│   ├── ClaudeRunner.ts         # Spawns `claude` CLI, parses JSON output
│   ├── SqliteRepo.ts           # Session + message persistence (Kysely)
│   └── TranscriptWriter.ts     # Appends exchanges to daily JSONL files
├── domain/
│   ├── entities/               # Session, Message types
│   └── services/result.ts      # Result<T, E> type (no exceptions)
├── db/
│   ├── index.ts                # Database init + migrations
│   ├── types.ts                # Kysely table types
│   └── migrations/             # Schema migrations
└── lib/
    ├── logger.ts               # Pino logger
    ├── slackFormatter.ts       # Markdown → Slack mrkdwn + message splitting
    ├── scheduleParser.ts       # schedule.yaml → cron matching
    └── memoryIndexer.ts        # FTS5 index builder (better-sqlite3)

scripts/
├── daily-synthesis.sh          # Consolidate JSONL → daily memory log
└── index-memory.sh             # Shell wrapper for index-memory CLI command

launchd/
├── goldfish-env.sh             # Shell env bootstrap for launchd
└── com.goldfish.daemon.plist   # Bot daemon (KeepAlive)
```

## How It Works

1. Slack message arrives via Socket Mode (WebSocket)
2. Bot looks up session by `(channel_id, thread_ts)` in SQLite
3. Spawns `claude -p "message" --resume <session_id> --output-format json`
4. Claude runs in the agent workspace (`GOLDFISH_WORKSPACE`) with full tool access
5. Response is formatted for Slack mrkdwn and sent back (split if >3900 chars)
6. Session ID and transcript are persisted for continuity

The agent's identity comes from the workspace's `CLAUDE.md`, not from Goldfish itself. Goldfish is the plumbing; the workspace defines who the agent is.

## Key Design Decisions

**Claude CLI over API:** Runs on a Claude Max subscription at zero marginal cost. No API billing, no token counting, no rate limits. The `--resume` flag gives us session continuity for free.

**`--dangerously-skip-permissions`:** The bot runs unattended — it can't prompt a human for tool approvals. This flag is required. The agent workspace's `CLAUDE.md` and hooks are the safety layer.

**Result<T, E> over exceptions:** All adapter methods return `Result` types. Errors are values, not surprises. See `domain/services/result.ts`.

**SQLite (Kysely) for sessions:** Lightweight, zero-config, runs anywhere. Sessions table maps Slack threads to Claude session IDs. Messages table logs all exchanges.

**JSONL transcripts + cron synthesis:** Raw exchanges go to `memory/sessions/YYYY-MM-DD.jsonl` in real time. A nightly cron job uses Sonnet to synthesize these into narrative daily logs. Cheap, reliable, no real-time LLM dependency.

**Slack mrkdwn formatting:** Claude outputs standard Markdown. `slackFormatter.ts` converts it (bold, headers, links, tables→lists). Messages over 3900 chars are split at paragraph boundaries.

**Self-message filtering:** Bot resolves its own user ID at startup and ignores messages from itself. Prevents infinite loops when listening on channels.

## Environment Variables

See `.env.example` for the full list. Required:
- `SLACK_APP_TOKEN` — Socket Mode app-level token
- `SLACK_BOT_TOKEN` — Bot OAuth token
- `GOLDFISH_WORKSPACE` — Path to the agent workspace

## After Code Changes

```bash
pnpm run build
launchctl stop com.goldfish.daemon    # KeepAlive auto-restarts with new code
```

## Conventions

- TypeScript strict mode, ESM (`"type": "module"`)
- Kysely for SQL (no raw queries outside migrations)
- Pino for structured logging
- No test mocking of SQLite — use real in-memory databases

## Git Conventions

**Atomic commits.** Each commit should be one logical change — a feature, a bugfix, a refactor. Don't bundle unrelated changes. Don't split a single logical change across commits unless it's genuinely separable (e.g., a migration + the code that uses it).

**Conventional commit messages:** `type: concise description`

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `style`, `perf`, `ci`

Examples:
- `feat: add Slack app manifest for one-click setup`
- `fix: prevent duplicate messages on reconnect`
- `refactor: extract session lookup into SessionService`
- `docs: add deployment troubleshooting section`

Keep the subject line under 72 characters. Use the body (separated by a blank line) for _why_, not _what_ — the diff shows what changed.


## Project Task Tracking

This project uses [taskmaster](https://github.com/eyaltoledano/claude-task-master) conventions for tracking tasks, with a `.taskmaster/tasks/tasks.json` using the following structure:

### Directory Structure
```
.taskmaster/
├── tasks/
│   └── tasks.json    # Active tasks
├── docs/
│   └── prd.txt       # Project requirements (optional)
└── archive.json      # Completed tasks (optional)
```

### Schema
```json
{
  "master": {
    "tasks": [
      {
        "id": 1,
        "title": "Brief task title",
        "description": "What needs to be done",
        "status": "pending|in-progress|done|review|deferred|cancelled",
        "priority": "high|medium|low",
        "dependencies": [],
        "subtasks": [
          {
            "id": 1,
            "title": "Subtask title",
            "description": "Subtask details",
            "status": "pending"
          }
        ]
      }
    ]
  }
}
```

### Guidelines
- Create a task when asked, or offer to create a task when a user proposes a complicated, multi-step task that will not be finished immediately.
- Query with: `jq '.master.tasks[] | select(.status=="pending")' .taskmaster/tasks/tasks.json`
- Archive completed tasks periodically to keep `.taskmaster/tasks/tasks.json` lightweight and focused on incomplete tasks.
- Test regularly and ensure high test coverage.
