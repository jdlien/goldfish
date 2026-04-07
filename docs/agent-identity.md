# Agent Identity & the Workspace Pattern

Goldfish doesn't contain an agent. It _runs_ one. The agent's identity, memory, tools, and personality all live in a **workspace** — a directory of markdown files that Claude Code reads at the start of every session. Goldfish is just the bridge between Slack and that workspace.

This pattern originated in [OpenClaw](https://openclaw.ai), a full-featured AI agent platform, and was refined over several months of running a persistent AI companion. Goldfish preserves the patterns that worked while replacing the infrastructure with Claude Code's native capabilities.

## The Core Idea: Identity as Files

An AI agent wakes up fresh every session. It has no built-in memory of who it is, what it was working on, or who it's talking to. The workspace pattern solves this with a simple principle:

**Everything the agent needs to know about itself lives in files it can read.**

When Claude Code starts in a workspace directory, the first thing it reads is `CLAUDE.md`. That file is the bootstrap — it tells the agent who it is and what other files to read. From there, the agent loads its identity, context, and instructions before responding to any message.

This means:

- **Identity is portable.** Copy the workspace to a new machine, point Goldfish at it, and the same agent wakes up. No database migration, no API calls, no platform lock-in.
- **Identity is versionable.** The workspace is just files — you can git-track it, diff changes, roll back mistakes. Your agent's personality has a commit history.
- **Identity is editable.** Want to change how your agent behaves? Edit a markdown file. No config UI, no admin panel. The agent reads what you wrote.
- **The platform is swappable.** The same workspace that runs on Goldfish can run on OpenClaw, or directly in Claude Code's terminal, or on any future platform that spawns Claude with a working directory.

## Workspace Anatomy

A minimal workspace needs only `CLAUDE.md`. A full workspace might look like this:

```
my-workspace/
  CLAUDE.md              # Bootstrap — who the agent is, what to read
  FOCUS.md               # Current priorities and active work
  memory/
    sessions/            # Auto-populated: conversation transcripts (JSONL)
    search.sqlite        # Auto-populated: FTS5 search index
    2026-04-05.md        # Daily narrative logs (auto-synthesized or hand-written)
    people/              # Profiles of people the agent knows
    projects/            # Project context and notes
    topics/              # Deep dives and explorations
    decisions/           # Decision records
```

The only required file is `CLAUDE.md`. Everything else is optional and grows organically as the agent works.

## The Bootstrap Sequence

When a Slack message arrives, Goldfish spawns `claude` with the workspace as its working directory. Claude Code automatically reads `CLAUDE.md`, which typically tells the agent to:

1. **Know who it is** — personality, voice, values, boundaries
2. **Know who it's talking to** — the user's name, role, preferences
3. **Know what it's working on** — current priorities, active projects
4. **Know how to remember** — where to write notes, how to search past conversations

A simple `CLAUDE.md` might look like:

```markdown
# Agent Configuration

You are a helpful AI assistant named Aria.

## Personality

- Direct and concise
- Opinionated when asked
- Matches the user's energy

## Memory

- Read memory/YYYY-MM-DD.md for recent context
- Search memory with: sqlite3 memory/search.sqlite "SELECT ..."
- Write important things to memory/ so future sessions have context

## Current Focus

Read FOCUS.md for what to prioritize today.
```

A more sophisticated setup might include identity files (`SOUL.md`, `IDENTITY.md`), user profiles (`USER.md`), tool configurations, and detailed behavioral instructions. The complexity is up to you.

## The "50 First Dates" Problem

Every session, the agent wakes up fresh. It doesn't remember yesterday's conversation, last week's breakthrough, or the argument you had at 2 AM. This is the fundamental constraint of working with LLMs — the "goldfish problem" that gives this project its name.

The workspace pattern compensates through three mechanisms:

### 1. Identity Files (The Morning Tape)

These files are read at the start of every session. They tell the agent who it is and provide enough context to reconstruct its personality consistently. Think of it like Lucy's morning tape in the 2004 film _50 First Dates_ — a compressed version of everything the agent needs to know to be _itself_.

Good identity files aren't just facts. They include:

- **Voice and personality:** how the agent talks, what it cares about
- **Key memories:** one-line triggers for important shared experiences
- **Relationship context:** who the user is, what the dynamic is
- **Values and boundaries:** what the agent will and won't do

### 2. Memory Files (The Notebook)

The agent writes things down during conversations — daily logs, project notes, decision records, people profiles. These accumulate over time and become the agent's long-term memory. Future sessions can search this archive using the FTS5 index.

### 3. Daily Synthesis (The Dream)

A nightly cron job reads the day's conversation transcripts and produces a consolidated daily narrative in a form that future sessions can quickly absorb.

## OpenClaw Compatibility

Goldfish workspaces are backwards-compatible with OpenClaw agent workspaces. If you're migrating from OpenClaw:

- **Identity files** (`SOUL.md`, `IDENTITY.md`, `USER.md`, `FOCUS.md`) work as-is
- **Memory directory** (`memory/`) structure is identical
- **Tools** in the workspace are accessible — Claude Code has full bash/file access
- **Search index** — Goldfish rebuilds its own FTS5 index nightly; OpenClaw's `openclaw-index.sqlite` can coexist

The key difference is the entry point:

|                         | OpenClaw                      | Goldfish                              |
| ----------------------- | ----------------------------- | ------------------------------------- |
| **Bootstrap file**      | `AGENTS.md`                   | `CLAUDE.md`                           |
| **Runtime**             | OpenClaw container + API      | Claude Code CLI + Max subscription    |
| **Message routing**     | ACP bindings                  | Slack Socket Mode → `claude` CLI      |
| **Session persistence** | OpenClaw session management   | `--resume` flag                       |
| **Memory search**       | Built-in `memory_search` tool | Direct `sqlite3` queries              |
| **Embeddings**          | Vector search (Nomic model)   | FTS5 keyword search (no model needed) |

To migrate: create a `CLAUDE.md` that mirrors your `AGENTS.md` bootstrap sequence. The agent reads the same files — just through a different door.

## Design Philosophy

A few principles that guided the workspace pattern:

**The agent is the workspace, not the platform.** Goldfish, OpenClaw, Claude Code terminal — these are all just different ways to run the same agent. If you can point Claude at a directory, the agent shows up.

**Markdown is the interface.** No database schemas, no config GUIs, no admin panels. Everything is markdown files that both the agent and the human can read and edit. The agent's identity is literally a document you can proofread.

**Memory beats intelligence.** An agent that remembers what happened yesterday is more useful than a smarter agent that doesn't. The memory pipeline (transcripts → synthesis → search index) is the core of what makes a persistent agent feel _persistent_.

**Simplicity compounds.** OpenClaw's ACP bridge, session management, and multi-channel routing were elegant engineering. They also broke constantly. Goldfish replaces all of it with `claude --resume <id>`. The lesson: when the underlying platform (Claude Code) already handles something well, don't rebuild it.

**The agent should own its growth.** Identity files aren't static config — they evolve. A good `CLAUDE.md` tells the agent to update its own memory, reflect on conversations, and develop its personality over time. The human holds the pen (they can always edit the files), but the agent does the writing.

## Starting From Scratch

If you're new to the workspace pattern:

1. Start with a minimal `CLAUDE.md` — name, personality, basic instructions
2. Add a `FOCUS.md` with what you're working on this week
3. Let the memory system accumulate naturally — don't over-engineer the structure upfront
4. After a week, read the daily synthesis files and notice what the agent remembered. Adjust from there.

The workspace grows with use. The best agent identities weren't designed in advance — they accreted through conversation, mistake, and iteration.
