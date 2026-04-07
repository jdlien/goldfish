# Goldfish

**AI agent runtime — a Claude Code-native Slack bot with persistent memory.**

Goldfish allows you to use Claude Code from Slack — but it's also much more than that. Think of it like the best parts of the OpenClaw AI assistant harness but dramatically simpler, polished for a specific use case. It's _your_ agent that knows _you_.

This gives you:

- **Full tool access:** Bash, file read/write, web search
- **Thread-based sessions:** Have multiple simultaneous slack threads across different channels.
- **Persistent memory:** Your agent can remember the most important details of your conversations over time and gets to know you personally, details about your life, and what you're working on.
- **Proactive outreach** — morning briefings, hourly heartbeat checks, and optional daily exploration sessions via cron jobs
- **Zero API cost** for conversations — everything runs through Claude Code on a Max subscription

## Why This Exists

OpenClaw is great, but it has some issues:

- It is complex to set up and keep working
- It had many bugs in its Slack integration

And crucially:

- Anthropic stopped allowing SSO auth with third-party harnesses like OpenClaw, so it became enormously expensive.
- Claude Code "just works" with a Claude Max subscription, OpenClaw had reliability issues with Claude models.

While OpenClaw could technically work via ACP bridges to Claude Code, there were many problems including zombie `claude` sessions and still required significant API usage (at full API costs) for certain features. This made it unusable in practice.

If you only want to use Claude over Slack, Goldfish does 90% of what OpenClaw did (when with 10% of the complexity:

| Feature            | OpenClaw                      | Goldfish                |
| ------------------ | ----------------------------- | ----------------------- |
| Conversations      | ACP bridge (fragile)          | Claude Code CLI (solid) |
| Session continuity | ACP session management        | `--resume` flag         |
| Memory             | Built-in indexer + embeddings | FTS5 + cron synthesis   |
| Channels           | Slack, Telegram, Signal       | Slack                   |
| Cost               | API Cost                      | Max Plan                |

Goldfish is compatible with OpenClaw agent workspaces. It can use the same identity files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `FOCUS.md`, etc.), memory directory structure, and tools. The key difference is the entry point: OpenClaw reads `AGENTS.md` as its primary instruction file, while Goldfish uses Claude Code's native `CLAUDE.md`. An OpenClaw workspace needs a `CLAUDE.md` that mirrors its `AGENTS.md` bootstrap sequence to work with Goldfish.

## Architecture

```
Slack message  → Goldfish daemon → spawns claude CLI → reads agent config → responds
                                                     → saves transcript to JSONL

schedule.yaml  → schedule run (cron, every minute)
               → morning / heartbeat / exploration / weekly  → Claude → Slack
               → daily-synthesis (1 AM)                      → Claude summarizes → memory/YYYY-MM-DD.md
               → index-memory (1:15 AM)                      → rebuilds FTS5     → memory/search.sqlite
```

Two launchd agents. One config file. That's the whole thing. See [`docs/deployment-macos.md`](docs/deployment-macos.md) for the full setup.

## Quick Start

**Prerequisites:** Node.js 22+, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), a Slack app with Socket Mode enabled.

This project uses [pnpm](https://pnpm.io/). If you don't have it, enable it via Node's built-in Corepack:

```bash
corepack enable
```

Then:

```bash
# Install dependencies
pnpm install

# Copy .env and fill in Slack tokens
cp .env.example .env

# Create an agent workspace (interactive — sets up identity, memory, prompts, schedule)
pnpm cli init

# Test connection
pnpm cli auth test

# Start the bot
pnpm cli start
```

## Configuration

Environment variables (in `.env`):

| Variable                     | Description                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| `SLACK_APP_TOKEN`            | Slack Socket Mode app-level token (Required)                        |
| `SLACK_BOT_TOKEN`            | Slack bot OAuth token (Required)                                    |
| `GOLDFISH_WORKSPACE`         | Path to agent workspace (default: `~/goldfish-workspace`)           |
| `GOLDFISH_CHANNELS`          | Comma-separated Slack channel IDs to listen on (in addition to DMs) |
| `GOLDFISH_DM_CHANNEL_ID`     | Default DM channel for proactive outreach                           |
| `GOLDFISH_MAX_TURNS`         | Max Claude Code turns per message (default: 50)                     |
| `GOLDFISH_TIMEOUT_MS`        | Claude Code timeout in ms (default: 300000)                         |
| `GOLDFISH_SESSION_EXPIRY_MS` | Session expiry in ms (default: 86400000 / 24h)                      |
| `GOLDFISH_SHOW_THINKING`     | Show "Thinking..." indicator (default: true)                        |

## Agent Identity

Goldfish is agent-agnostic. The agent's identity comes from the workspace it points at, not from Goldfish itself. Claude Code reads `CLAUDE.md` in the workspace root, which bootstraps whatever identity files, tools, and context you configure.

This means you can use Goldfish as:

- A personal assistant with memory, opinions, and persistent personality
- A project-specific agent with domain context
- A team bot with shared knowledge
- A drop-in replacement for an [OpenClaw](https://openclaw.ai) agent (same workspace, simpler runtime)
- Anything else you can define in a `CLAUDE.md`

The workspace pattern — identity as markdown files, memory as a searchable archive, personality that evolves through conversation — is the core of what makes a persistent agent feel _persistent_. See [`docs/agent-identity.md`](docs/agent-identity.md) for the full design philosophy, workspace anatomy, and migration guide from OpenClaw.

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

Goldfish uses a single `schedule.yaml` to run tasks on a schedule — briefings, heartbeats, maintenance, whatever you need. A launchd agent fires every 60 seconds and runs any due tasks:

```yaml
tasks:
  - type: morning
    at: "8:30am"
    channel: C0ABC123DEF

  - type: heartbeat
    every: hour
    between: "10am-5pm"
    days: weekdays
    channel: C0ABC123DEF

  - type: daily-synthesis
    at: "1:00am"

  - type: index-memory
    at: "1:15am"
```

See [`docs/scheduling.md`](docs/scheduling.md) for the full reference — all fields, task types, timing syntax, locking, and configuration options.

## Memory System

Goldfish maintains memory through three layers:

1. **In-session:** The agent writes to memory files during conversations (daily notes, project files, etc.)
2. **Post-session transcripts:** Every message exchange is appended to `memory/sessions/YYYY-MM-DD.jsonl`
3. **Daily synthesis:** A cron job to consolidate the day's transcripts into a narrative daily log

Search memory from within a Claude session:

```bash
sqlite3 memory/search.sqlite \
  "SELECT path, snippet(chunks_fts, 0, '>>>', '<<<', '...', 40) \
   FROM chunks_fts WHERE chunks_fts MATCH 'search terms' \
   ORDER BY rank LIMIT 10;"
```

## The Name

Goldfish are commonly thought to have 3-second memories. [It turns out that's a myth](https://www.sciencing.com/1881847/myth-goldfish-memories-you-believe/) — they can remember for months. But an LLM-based AI-agent is kind of like that. Almost no short-term memory, but we create a long-term memory by writing everything down obsessively.

## License

MIT
