<p align="center">
  <img src="assets/goldfish-logo.webp" alt="Goldfish" width="450">
</p>

<p align="center"><strong>AI agent runtime — a Claude Code or OpenAI Codex Slack bot with persistent memory.</strong></p>

Goldfish lets you run either Anthropic Claude Code or OpenAI Codex from Slack. Think of it like the best parts of an AI assistant harness, kept deliberately small: it is _your_ agent, in _your_ workspace, using the model you select.

This gives you:

- **Full tool access:** Bash, file read/write, web search
- **Thread-based sessions:** Multiple simultaneous Slack threads across different channels
- **Persistent memory:** Your agent remembers the most important details of your conversations over time and gets to know you personally, details about your life, and what you're working on
- **Proactive outreach:** Morning briefings, hourly heartbeat checks, and optional daily exploration sessions via scheduled tasks and reminders
- **Subscription-backed CLIs:** Use an authenticated Claude Code or Codex CLI without wiring API billing into Goldfish
- **Explicit model routing:** Choose Claude or GPT globally, by Slack channel, or by scheduled task

## Why This Exists

OpenClaw is great, but it has some issues:

- It is complex to set up and keep working
- It had many bugs in its Slack integration

And crucially:

- Anthropic stopped allowing SSO auth with third-party harnesses like OpenClaw, so it became enormously expensive
- Claude Code "just works" with a Claude Max subscription; OpenClaw had reliability issues with Claude models

While OpenClaw could technically work via ACP bridges to Claude Code, there were many problems including zombie `claude` sessions and it still required significant API usage (at full API costs) for certain features. This made it unusable in practice.

If you want to use a coding-agent runtime over Slack, Goldfish keeps the plumbing small:

| Feature            | OpenClaw                      | Goldfish                |
| ------------------ | ----------------------------- | ----------------------- |
| Conversations      | ACP bridge (fragile)          | Claude Code or Codex CLI |
| Session continuity | ACP session management        | Native provider sessions |
| Memory             | Built-in indexer + embeddings | FTS5 + semantic vectors + scheduled synthesis |
| Channels           | Slack, Telegram, Signal       | Slack                   |
| Cost               | API Cost                      | Max Plan                |

Goldfish is compatible with OpenClaw-style workspaces. Claude Code discovers `CLAUDE.md`; Codex discovers `AGENTS.md`. Keep both files in the workspace when you want to switch providers. They can share the same identity files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `FOCUS.md`), memory, and tools.

## Architecture

```
Slack message  → Goldfish daemon → runtime resolver → Claude Code or Codex → responds
                                                      → saves transcript to JSONL

<workspace>/schedule.yaml  → schedule run (every minute)
               → morning / heartbeat / exploration / weekly  → selected backend → Slack
               → daily-synthesis (1 AM)                      → selected backend → memory/YYYY-MM-DD.md
               → index-memory (1:15 AM)                      → FTS5 + vectors    → memory/search.sqlite
```

Two launchd agents. One config file. That's the whole thing. See [`docs/deployment-macos.md`](docs/deployment-macos.md) for the full setup.

## Quick Start

**Prerequisites:** Node.js 22+, a Slack app with Socket Mode enabled, and at least one authenticated agent CLI: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [OpenAI Codex](https://developers.openai.com/codex/cli).

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

### Manually configure Claude Code

1. Install Claude Code, run `claude`, and complete its login flow.
2. Put a `CLAUDE.md` in the root of `GOLDFISH_WORKSPACE`. This is Claude's entry point for the agent identity and workspace instructions.
3. Select Claude in `.env`:

```bash
GOLDFISH_BACKEND=claude
GOLDFISH_CLAUDE_MODEL=sonnet   # optional; omit for the Claude CLI default
GOLDFISH_EFFORT=high           # optional: low | medium | high | xhigh | max
GOLDFISH_CLAUDE_PATH=claude
```

4. Verify both Slack and the CLI with `pnpm cli auth test`.

Existing installations may continue using `GOLDFISH_MODEL` and `GOLDFISH_MODEL_BY_CHANNEL`; those names are deprecated aliases for Claude settings only.

### Manually configure OpenAI Codex

1. Install the Codex CLI, run `codex login`, and verify it with `codex login status`. Goldfish uses the CLI version pinned by `@openai/codex-sdk` for actual runs; the standalone CLI is only needed for initial authentication and manual use.
2. Put an `AGENTS.md` in the root of `GOLDFISH_WORKSPACE`. This is Codex's entry point for the agent identity and workspace instructions. `pnpm cli init` creates both `CLAUDE.md` and `AGENTS.md` without overwriting either one.
3. Select Codex and its unattended execution policy in `.env`:

```bash
GOLDFISH_BACKEND=codex
GOLDFISH_CODEX_MODEL=gpt-6-astra  # optional; omit for the Codex CLI default
GOLDFISH_EFFORT=high              # optional: minimal | low | medium | high | xhigh | max | ultra
GOLDFISH_CODEX_SANDBOX=workspace-write
GOLDFISH_CODEX_NETWORK=true
GOLDFISH_CODEX_WEB_SEARCH=cached
# GOLDFISH_CODEX_ADDITIONAL_DIRECTORIES=/another/writable/root
# GOLDFISH_CODEX_PATH=/absolute/path/to/codex  # optional expert override
```

`workspace-write` is the recommended Codex default: it allows normal agent work inside the workspace while preventing unrestricted host writes. Use `read-only` for inspection-only agents. `danger-full-access` removes that boundary and should only be enabled deliberately on a machine and workspace you trust.

Goldfish enables command network access by default because workspace tools commonly call Slack and other network services. Set `GOLDFISH_CODEX_NETWORK=false` for an offline agent. Web search is controlled separately: `cached` is the default, while `disabled` forbids it and `live` allows fresh searches. Additional directories extend the writable workspace and should only name paths you trust.

4. Run `pnpm run build`, then `pnpm cli auth test` and `pnpm cli start`.

Switching providers intentionally starts a new provider session for each Slack thread. The workspace, transcripts, and long-term memory remain available, but Claude's in-model conversation state is not transferable to Codex (or vice versa). Switching models within the same provider can continue the existing session.

An explicit `backend` on a scheduled check-in pins that check-in's Slack thread to the selected provider, so replies continue the session that produced the post. It does not change the channel default; ordinary threads still follow global and per-channel configuration changes.

## Configuration

Environment variables (in `.env`):

| Variable | Description |
| --- | --- |
| `SLACK_APP_TOKEN` | Slack Socket Mode app-level token (required) |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (required) |
| `GOLDFISH_WORKSPACE` | Agent workspace (default: `~/goldfish-workspace`) |
| `GOLDFISH_BACKEND` | Default runtime: `claude` or `codex` (default: `claude`) |
| `GOLDFISH_BACKEND_BY_CHANNEL` | JSON map of Slack channel ID to backend |
| `GOLDFISH_CLAUDE_MODEL` | Default Claude model; omitted means Claude CLI default |
| `GOLDFISH_CLAUDE_PATH` | Claude executable path (default: `claude`) |
| `GOLDFISH_CODEX_MODEL` | Default Codex/GPT model; omitted means Codex CLI default |
| `GOLDFISH_CLAUDE_MODEL_BY_CHANNEL` | JSON map of channel ID to Claude model |
| `GOLDFISH_CODEX_MODEL_BY_CHANNEL` | JSON map of channel ID to Codex model |
| `GOLDFISH_EFFORT` | Shared default reasoning effort |
| `GOLDFISH_EFFORT_BY_CHANNEL` | JSON map of channel ID to reasoning effort |
| `GOLDFISH_CODEX_SANDBOX` | `read-only`, `workspace-write`, or `danger-full-access` |
| `GOLDFISH_CODEX_NETWORK` | Allow network from agent commands (default: `true`) |
| `GOLDFISH_CODEX_WEB_SEARCH` | Codex web search mode: `disabled`, `cached`, or `live` (default: `cached`) |
| `GOLDFISH_CODEX_ADDITIONAL_DIRECTORIES` | Extra writable roots separated by the platform path delimiter |
| `GOLDFISH_CODEX_PATH` | Optional executable override; unset uses the SDK-pinned bundled CLI |
| `GOLDFISH_CHANNELS` | Comma-separated channels to listen on, in addition to DMs |
| `GOLDFISH_DM_CHANNEL_ID` | Default DM channel for proactive outreach |
| `GOLDFISH_MAX_TURNS` | Claude turn ceiling (default: 50; Codex has no equivalent) |
| `GOLDFISH_TIMEOUT_MS` | Per-run timeout in milliseconds (default: 900000) |
| `GOLDFISH_SESSION_EXPIRY_MS` | Provider-session expiry (default: 48 hours) |
| `GOLDFISH_SHOW_THINKING` | Show the legacy "Thinking..." indicator |

### Per-channel provider, model, and effort

Every message resolves one backend, a model for that backend, and a reasoning effort. Channel overrides win over global defaults. Provider model maps are separate so a Claude model name can never be passed to Codex, or the reverse.

- `GOLDFISH_EFFORT` sets a default applied to every channel.
- `GOLDFISH_EFFORT_BY_CHANNEL` is a JSON object mapping channel ID → level; it overrides the default.
- A channel with no model or effort configured uses the selected CLI's default.
- Claude accepts `low`, `medium`, `high`, `xhigh`, and `max`; Codex also supports `minimal` and `ultra` where the selected model supports them.

```bash
# Claude by default; route one work channel to Codex.
GOLDFISH_BACKEND=claude
GOLDFISH_BACKEND_BY_CHANNEL='{"C0WORKCHAN1":"codex"}'
GOLDFISH_CLAUDE_MODEL=sonnet
GOLDFISH_CODEX_MODEL=gpt-6-astra
GOLDFISH_EFFORT_BY_CHANNEL='{"C0A7VB1U6EA":"low","C0WORKCHAN1":"high"}'
```

> **⚠️ Quote the JSON with single quotes.** The launchd wrapper (`launchd/goldfish-env.sh`)
> loads `.env` by `source`-ing it in bash, which strips **double** quotes out of the value —
> turning `{"C123":"low"}` into invalid `{C123:low}` that silently parses to an empty map.
> Wrapping the whole value in **single** quotes preserves the inner double quotes through both
> bash sourcing and dotenv. (This bites any JSON-valued variable in `.env`, not just this one.)

After editing `.env`, restart the daemon so the new environment is picked up:
`launchctl kickstart -k gui/$(id -u)/com.jdlien.goldfish.daemon` (run `npm run build` first
if you also changed source — the daemon runs the compiled `dist/`, not `src/`).

## Agent Identity

Goldfish is model-agnostic. The agent's identity comes from its workspace, not Goldfish. Claude Code reads `CLAUDE.md`; Codex reads `AGENTS.md`. Put shared personality and memory instructions in both entry points, or have both tell the runtime to read the same supporting identity files.

This means you can use Goldfish as:

- A personal assistant with memory, opinions, and persistent personality
- A project-specific agent with domain context
- A team bot with shared knowledge
- A drop-in replacement for an [OpenClaw](https://openclaw.ai) agent (same workspace, simpler runtime)
- Anything else you can define in `CLAUDE.md` and `AGENTS.md`

The workspace pattern (identity as markdown files, memory as a searchable archive, personality that evolves through conversation) is the core of what makes a persistent agent feel _persistent_. See [`docs/agent-identity.md`](docs/agent-identity.md) for the full design philosophy, workspace anatomy, and migration guide from OpenClaw.

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

Goldfish uses a single `schedule.yaml` in your workspace (default: `~/goldfish-workspace/schedule.yaml`) to define scheduled tasks: briefings, heartbeats, maintenance, whatever you need. A launchd agent fires every 60 seconds and runs any due tasks:

```yaml
tasks:
  - type: morning
    at: "8:30am"
    channel: C0ABC123DEF
    backend: codex          # optional per-task override
    model: gpt-6-astra
    effort: medium

  - type: heartbeat
    every: hour
    between: "10am-5pm"
    days: weekdays
    channel: C0ABC123DEF

  - type: daily-synthesis
    at: "1:00am"
    backend: codex          # otherwise inherits GOLDFISH_BACKEND

  - type: index-memory
    at: "1:15am"
```

See [`docs/scheduling.md`](docs/scheduling.md) for the full reference: all fields, task types, timing syntax, locking, and configuration options.

## Memory System

Goldfish maintains memory through three layers:

1. **In-session:** The agent writes to memory files during conversations (daily notes, project files, etc)
2. **Post-session transcripts:** Every message exchange is appended to `memory/sessions/YYYY-MM-DD.jsonl`
3. **Daily synthesis:** A scheduled task consolidates the day's transcripts into a narrative daily log

Search memory from within either provider's session — keyword, semantic, or both (fused):

```bash
goldfish search "what you're looking for"        # hybrid: keyword ∪ semantic (default)
goldfish search "exact tokens" --mode fts        # keyword only, no model load
goldfish search "a conceptual question" --json   # stable JSON for tools

# Semantic search needs a one-time model download:
goldfish embeddings setup
```

The index is a plain SQLite DB, so raw FTS5 still works as a fallback:

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
