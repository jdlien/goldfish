# Goldfish

**AI agent runtime — a Claude Code-native Slack bot with persistent memory.**

Goldfish allows you to use Claude Code from Slack — but it's also much more than that. It's like we took the best parts of OpenClaw but made it dramatically simpler and polished for a specific use case — Claude Code + Slack. But _your_ agent that knows you.

This gives you:
- **Full tool access:** Bash, file read/write, web search
- **Thread-based sessions:** Have multiple simultaneous slack threads across different channels.
- **Persistent memory:** Your agent can remember the most important details of your conversations over time and gets to know you personally, details about your life, and what you're working on.
- **Proactive outreach** — morning briefings, hourly heartbeat checks, and optional daily exploration sessions via cron jobs
- **Zero API cost** for conversations — everything runs through Claude Code on a Max subscription

## Why This Exists

I was a happy user of OpenClaw, but over time, I discovered issues:
- It complex to set up and keep working
- It had many bugs. While it is open source, the popularity of the project means that my pull requests were unlikely to get merged in.
- Anthropic stopped allowing SSO auth with third-party harnesses like OpenClaw, so it became enormously expensive.
- Claude Code "just works" with a Claude Max subscription, OpenClaw had reliability issues with Claude models.

While OpenClaw could technically work via ACP bridges, there were many problems including zombie `claude` sessions and still required significant API usage (at full API costs), and it required frequent restarts. This made it unusable in practice.

Goldfish does 90% of what OpenClaw did with 10% of the complexity:

| Feature            | OpenClaw                      | Goldfish                |
| ------------------ | ----------------------------- | ------------------------|
| Conversations      | ACP bridge (fragile)          | Claude Code CLI (solid) |
| Session continuity | ACP session management        | `--resume` flag         |
| Memory             | Built-in indexer + embeddings | FTS5 + cron synthesis   |
| Channels           | Slack, Telegram, Signal       | Slack                   |
| Cost               | API Cost                      | Max Plan                |

Goldfish is compatible with OpenClaw agent workspaces. It can use the same identity files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `FOCUS.md`, etc.), memory directory structure, and tools. The key difference is the entry point: OpenClaw reads `AGENTS.md` as its primary instruction file, while Goldfish uses Claude Code's native `CLAUDE.md`. An OpenClaw workspace needs a `CLAUDE.md` that mirrors its `AGENTS.md` bootstrap sequence to work with Goldfish.

## Architecture

```
Slack message → Goldfish daemon → spawns claude CLI → reads agent config → responds
                                                    → saves transcript to JSONL

Cron (1:00 AM)  → daily-synthesis.sh   → Sonnet summarizes the day → memory/YYYY-MM-DD.md
Cron (1:15 AM)  → index-memory.sh      → Python rebuilds FTS5 index → memory/search.sqlite
Cron (every min) → schedule run         → Checks schedule.yaml, fires due tasks
```

One daemon. One cron entry. A config file. That's the whole thing. See [`docs/deployment-macos.md`](docs/deployment-macos.md) for the full launchd setup.

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy .env and fill in Slack tokens
cp .env.example .env

# Test connection
pnpm run cli auth test

# Start the bot
pnpm run cli start
```

## Configuration

Environment variables (in `.env`):

| Variable                     | Required | Description                                                               |
| ---------------------------- | -------- | ------------------------------------------------------------------------- |
| `SLACK_APP_TOKEN`            | Yes      | Slack Socket Mode app-level token                                         |
| `SLACK_BOT_TOKEN`            | Yes      | Slack bot OAuth token                                                     |
| `GOLDFISH_WORKSPACE`         | No       | Path to agent workspace (default: `~/goldfish-workspace`) |
| `GOLDFISH_CHANNELS`          | No       | Comma-separated Slack channel IDs to listen on (in addition to DMs)       |
| `GOLDFISH_DM_CHANNEL_ID`     | No       | Default DM channel for proactive outreach                                 |
| `GOLDFISH_MAX_TURNS`         | No       | Max Claude Code turns per message (default: 50)                           |
| `GOLDFISH_TIMEOUT_MS`        | No       | Claude Code timeout in ms (default: 300000)                               |
| `GOLDFISH_SESSION_EXPIRY_MS` | No       | Session expiry in ms (default: 86400000 / 24h)                            |
| `GOLDFISH_SHOW_THINKING`     | No       | Show "Thinking..." indicator (default: true)                              |

## Agent Identity

Goldfish is agent-agnostic. The agent's identity comes from the workspace it points at, not from Goldfish itself. Claude Code reads `CLAUDE.md` in the workspace root, which bootstraps whatever identity files, tools, and context you configure.

This means you can use Goldfish as:

- A personal assistant with memory, opinions, and persistent personality
- A project-specific agent with domain context
- A team bot with shared knowledge
- A drop-in replacement for an [OpenClaw](https://openclaw.ai) agent (same workspace, simpler runtime)
- Anything else you can define in a `CLAUDE.md`

The workspace pattern — identity as markdown files, memory as a searchable archive, personality that evolves through conversation — is the core of what makes a persistent agent feel *persistent*. See [`docs/agent-identity.md`](docs/agent-identity.md) for the full design philosophy, workspace anatomy, and migration guide from OpenClaw.

## Commands

```bash
goldfish start                          # Start the bot daemon
goldfish auth status                    # Check token configuration
goldfish auth test                      # Test Slack API connection
goldfish send -m "Hello" -c <channel>   # Send a message manually
goldfish upload -f report.pdf -c <ch>   # Upload a file
goldfish initiate -t morning            # Trigger a morning briefing
goldfish initiate -t weekly             # Trigger a weekly review
goldfish initiate -t heartbeat          # Silent urgency check (pings only if actionable)
goldfish initiate -t exploration        # Agent picks a topic and goes deep
goldfish initiate --reminder "Call back about the service agreement"
goldfish schedule list                  # Show all scheduled tasks
goldfish schedule run                   # Run any tasks due now
goldfish schedule run --dry-run         # Preview what would run
```

## Scheduling

Instead of managing raw crontab entries, Goldfish uses a single `schedule.yaml` config file:

```yaml
tasks:
  - name: morning
    type: morning
    at: "8:30am"
    channel: C0A7FUF68PR

  - name: heartbeat
    type: heartbeat
    every: hour
    between: "10am-5pm"
    days: weekdays
    channel: C0A7FUF68PR

  - name: exploration
    type: exploration
    at: "6pm"
    channel: C0ANY8E67UP
```

### Schedule syntax

| Field     | Examples                              | Description                        |
| --------- | ------------------------------------- | ---------------------------------- |
| `at`      | `"8:30"`, `"8:30am"`, `"6pm"`        | Run once a day at this time        |
| `every`   | `"hour"`, `"2 hours"`, `"4 hours"`   | Repeating interval                 |
| `between` | `"10am-5pm"`, `"10:00-17:00"`        | Window for `every` (optional)      |
| `days`    | `daily`, `weekdays`, `weekends`, `monday`, `mon,wed,fri` | Which days (default: daily) |
| `cron`    | `"0 10-17 * * 1-5"`                  | Raw cron — overrides all above     |
| `enabled` | `true` / `false`                     | Disable without removing (default: true) |

Times accept 12-hour (`8:30am`, `6pm`) or 24-hour (`18:00`) format.

### Running the scheduler

One cron entry drives everything:

```bash
* * * * * cd /path/to/goldfish && node dist/index.js schedule run >> /tmp/goldfish-schedule.log 2>&1
```

Goldfish checks `schedule.yaml` each minute and fires any matching tasks. Lock files prevent overlapping runs of the same task.

## Memory System

Goldfish maintains memory through three layers:

1. **In-session** — The agent writes to memory files during conversations (daily notes, project files, etc.)
2. **Post-session transcripts** — Every message exchange is appended to `memory/sessions/YYYY-MM-DD.jsonl`
3. **Daily synthesis** — A cron job uses Sonnet to consolidate the day's transcripts into a narrative daily log

Search memory from within a Claude session:

```bash
sqlite3 memory/search.sqlite \
  "SELECT path, snippet(chunks_fts, 0, '>>>', '<<<', '...', 40) \
   FROM chunks_fts WHERE chunks_fts MATCH 'search terms' \
   ORDER BY rank LIMIT 10;"
```

## The Name

Goldfish are commonly thought to have 3-second memories. [That's actually a myth](https://www.sciencing.com/1881847/myth-goldfish-memories-you-believe/) — they can remember for months. Same idea here: a system with no built-in persistent memory that compensates by writing everything down obsessively.

## License

MIT
