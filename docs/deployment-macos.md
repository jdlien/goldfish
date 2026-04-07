# Goldfish — macOS Deployment

Run Goldfish as a persistent service on macOS using launchd + cron.

## Overview

Goldfish has two runtime components:

| Component        | How it runs              | Purpose                                                   |
| ---------------- | ------------------------ | --------------------------------------------------------- |
| **Slack daemon** | launchd (always running) | Listens for Slack messages, spawns Claude sessions        |
| **Scheduler**    | cron (every minute)      | Reads `schedule.yaml`, fires due tasks (heartbeats, etc.) |

### The Scheduler (`schedule.yaml`)

All scheduled tasks — proactive Slack messages and nightly maintenance — are defined in `schedule.yaml` and driven by a single cron entry:

```
* * * * * cd ~/code/goldfish && node dist/index.js schedule run >> /tmp/goldfish-schedule.log 2>&1
```

See [`scheduling.md`](scheduling.md) for the full reference (task types, timing syntax, all fields, locking behavior).

The daemon runs via a launchd plist (`com.goldfish.daemon`) which provides `KeepAlive` for auto-restart on crash. All other tasks (briefings, heartbeats, synthesis, indexing) run through the scheduler.

## Prerequisites

- Node.js 22+ and pnpm
- Claude Code CLI (`claude`) in PATH
- Slack app configured (see main README)
- `.env` file with Slack tokens and `GOLDFISH_WORKSPACE`

## Setup

### 1. Install Dependencies and Build

```bash
cd ~/code/goldfish
pnpm install
pnpm run build    # IMPORTANT: The daemon runs compiled JS, not tsx
```

> **Note:** You must run `pnpm run build` after any code changes. The daemon
> plist runs `node dist/index.js start` (compiled output), not the tsx dev
> server. If you skip the build step, the daemon will fail with MODULE_NOT_FOUND.

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Slack tokens and workspace path
```

Required variables:

- `SLACK_APP_TOKEN` — Slack Socket Mode app-level token (`xapp-1-...`)
- `SLACK_BOT_TOKEN` — Slack bot OAuth token (`xoxb-...`)
- `GOLDFISH_WORKSPACE` — Absolute path to your agent workspace
- `GOLDFISH_DM_CHANNEL_ID` — Default Slack channel for proactive messages (briefings, heartbeats, explorations)

### 3. Set Up Your Workspace

```bash
pnpm cli init
```

The init wizard creates your agent workspace — identity files, memory directories, prompt templates, and `schedule.yaml`. If you're migrating from OpenClaw, it will detect your `AGENTS.md` and offer to use it as the base for `CLAUDE.md`.

### 4. Test the Connection

```bash
pnpm cli auth test
```

You should see your workspace name, bot name, and Claude CLI version.

### 5. Install the Daemon Plist

The daemon plist keeps the Slack listener running and auto-restarts on crash.

```bash
cp launchd/com.goldfish.daemon.plist ~/Library/LaunchAgents/
```

The plist references `~/code/goldfish` as the install path. If your repo is elsewhere, edit the plist before copying.

```bash
# Start the daemon (starts immediately and on every login)
launchctl load ~/Library/LaunchAgents/com.goldfish.daemon.plist
```

### 6. Set Up the Scheduler

Add one cron entry to drive all scheduled tasks:

```bash
crontab -e
```

```
* * * * * cd ~/code/goldfish && node dist/index.js schedule run >> /tmp/goldfish-schedule.log 2>&1
```

Edit `schedule.yaml` (created by `pnpm cli init`) to set your channel IDs and preferred times. See [`scheduling.md`](scheduling.md) for the full reference.

### 7. Verify

```bash
# Check the daemon is running
launchctl list | grep goldfish

# Watch the daemon logs
tail -f /tmp/goldfish-daemon.log

# Preview what the scheduler would run right now
pnpm cli schedule run --dry-run

# List all scheduled tasks and their cron expressions
pnpm cli schedule list
```

You should see "Goldfish started!" and "Listening for messages..." in the daemon log. Send a DM to the bot in Slack to confirm it responds.

## The `initiate` Pattern

All proactive outreach types share a single CLI entrypoint:

```bash
pnpm cli initiate -t <type>
```

Supported types: `heartbeat`, `morning`, `weekly`, `exploration`.

Each type looks for a prompt template in your workspace's `prompts/` directory first (e.g. `prompts/morning.md`), falling back to built-in defaults in `src/cli/initiate.ts`. The plumbing (loading environment, spawning Claude, posting to Slack, creating a session so thread replies continue the conversation) is shared. Adding a new scheduled proactive task is usually:

1. Create a prompt file in `prompts/<type>.md` in your workspace (or add a case to `buildPrompt()` in `src/cli/initiate.ts`)
2. Add the new type to the `InitiateOptions.type` union in `src/cli/initiate.ts`
3. Add a task entry in `schedule.yaml`
4. `pnpm run build`

No new scripts, no new runner code, no new database tables. The heartbeat has
one special behavior — if the agent's response starts with `HEARTBEAT_OK`, no
Slack message is sent at all — but everything else routes through the same
path.

## The Exploration Pattern

`exploration` is listed as "optional" because it's the least universal of the
scheduled jobs, but the underlying pattern is broadly useful: **a daily
scheduled long-running task where the agent chooses the subject matter itself,
then posts the result to Slack for you to optionally engage with.**

In the default workspace, exploration is an evening self-study session
where the agent picks a topic that interests it, goes deep (800–2000 words),
and saves the result to `memory/explorations/`. It's part of how the agent
develops and expresses independent interests.

But the same mechanism can be repurposed:

- **Daily news digest** — have the agent pick a topic area you care about, fetch recent posts, summarize them
- **Reading queue processor** — work through a stack of bookmarks/articles and write summaries
- **Research trawl** — monitor a field you're tracking and surface what's new
- **Journal** — reflect on the day's transcripts and write a private note
- **Creative writing** — daily short-form output on a rotating prompt

To adapt exploration for a different purpose, create `prompts/exploration.md` in your workspace directory (or edit the `exploration` case in `buildPrompt()` inside `src/cli/initiate.ts`) and rewrite the prompt to tell the agent what you want it to do.

## Shell Environment (`goldfish-env.sh`)

launchd runs with a minimal PATH that doesn't include tools installed via
Homebrew, fnm, pyenv, etc. Every Goldfish plist invokes its command through
`launchd/goldfish-env.sh`, which:

1. Sources `~/.zprofile` and `~/.zshrc` (bringing in your normal PATH, fnm, pyenv)
2. Loads `.env` from the goldfish repo (Slack tokens, config)
3. Exports `GOLDFISH_WORKSPACE` if not already set

If your shell setup is non-standard — bash instead of zsh, a different
profile location, a version manager Goldfish doesn't know about — edit
`goldfish-env.sh` to source whatever you need. After editing, reload the
affected plists (`launchctl unload` + `launchctl load`) so they pick up the
new environment on their next fire.

You can smoke-test the env script in isolation:

```bash
bash -c 'source ~/code/goldfish/launchd/goldfish-env.sh && which claude && which node && which pnpm'
```

All three binaries should resolve. If any don't, that's what launchd will see,
and your jobs will fail with "command not found."

## Launchd Gotchas

### Sleeping Machines Miss Scheduled Tasks

This is the single biggest thing to know. Neither cron nor launchd will wake a sleeping Mac:

1. **Cron does not wake the machine.** If your Mac is asleep at 1:00 AM, the scheduler doesn't run, and the 1:00 AM synthesis is silently skipped.
2. **Missed runs are not queued.** When the Mac wakes up at 9:00 AM, cron does _not_ go back and fire the jobs it missed. They just wait for their next scheduled minute.

Options if you need overnight jobs to run reliably:

- **Keep the machine awake.** `caffeinate -s` in a terminal, or disable sleep
  in System Settings → Displays & Energy.
- **Schedule a pmset wake event.** `sudo pmset repeat wakeorpoweron MTWRFSU 00:58:00`
  wakes the Mac at 00:58 every night, giving launchd a live machine at 1:00 AM.
- **Reschedule for waking hours.** Move the jobs to a time the machine is
  reliably on (e.g. 9:00 AM instead of 1:00 AM). This is the cheapest option
  and what most personal deployments should do.
### LaunchAgents Require an Active Login Session

The daemon plist runs as a LaunchAgent under your user, so it stops when you're logged out. If you want Goldfish running while nobody is logged in, you'd need to move the plist to `/Library/LaunchDaemons/` and run it as a system service — that has its own setup and is not covered here.

### `runs = 0` Is Not Necessarily a Bug

If `launchctl print gui/$(id -u)/com.goldfish.daemon` shows
`runs = 0`, that means the daemon hasn't fired _since it was loaded_. If you
just loaded it, give it a moment. Don't panic — check whether it had a chance to start.

## Managing Services

```bash
# Stop the daemon (launchd will restart it due to KeepAlive)
launchctl stop com.goldfish.daemon

# Actually stop it (unload removes it from launchd entirely)
launchctl unload ~/Library/LaunchAgents/com.goldfish.daemon.plist

# Start it again
launchctl load ~/Library/LaunchAgents/com.goldfish.daemon.plist

# Reload after editing a plist
launchctl unload ~/Library/LaunchAgents/com.goldfish.daemon.plist
launchctl load ~/Library/LaunchAgents/com.goldfish.daemon.plist

# Run a scheduled task manually (for testing)
pnpm cli initiate -t morning
pnpm cli initiate -t heartbeat
pnpm cli initiate -t exploration
```

## After Code Changes

When you update goldfish source code:

```bash
cd ~/code/goldfish
pnpm run build                      # Recompile TypeScript
launchctl stop com.goldfish.daemon  # launchd auto-restarts with new code
```

Scheduled jobs pick up new code automatically on their next fire — they spawn
a fresh node process each time and don't hold cached state.

## Logs

| Service   | Log location                  |
| --------- | ----------------------------- |
| Daemon    | `/tmp/goldfish-daemon.log` (stdout), `/tmp/goldfish-daemon-err.log` (stderr) |
| Scheduler | `/tmp/goldfish-schedule.log` (all scheduled tasks — briefings, synthesis, indexing) |

> **Tip:** Logs are in `/tmp/` which macOS clears on reboot. For persistent
> logs, change the plist paths to `~/Library/Logs/goldfish/` and create the
> directory first.

## Troubleshooting

**Daemon crashes immediately (exit code 1):**

```bash
cat /tmp/goldfish-daemon-err.log
```

Common causes:

- Forgot to run `pnpm run build` — `dist/index.js` doesn't exist
- Missing `.env` file or Slack tokens not set
- Another process already connected to the same Slack Socket Mode token
  (only one connection per app token is allowed)

**Daemon shows exit code -15:**
That's SIGTERM — launchd sent a stop signal. Normal during restarts.
`KeepAlive` will relaunch it within the `ThrottleInterval` (10s).

**Scheduled tasks not firing:**

- Verify cron is running: `crontab -l` should show the `schedule run` entry
- Check the scheduler log: `cat /tmp/goldfish-schedule.log`
- Preview what would run: `pnpm cli schedule run --dry-run`
- List all tasks and their cron expressions: `pnpm cli schedule list`
- Test a task manually: `pnpm cli initiate -t morning`
- Check for stale lock files in `.schedule-locks/` (auto-cleaned after 20 minutes)

**"Command not found" errors in scheduled jobs:**

- Edit `launchd/goldfish-env.sh` to ensure your shell profile is sourced correctly
- Smoke-test: `bash -c 'source ~/code/goldfish/launchd/goldfish-env.sh && which claude && which node && which pnpm'`

**Heartbeat runs but nothing appears in Slack:**
That's probably working as designed. The heartbeat stays silent when nothing
is actionable — the log will show `Heartbeat: nothing actionable. Staying silent.`
and `Heartbeat OK — no message sent`. Only genuinely urgent items produce a
Slack message.

**Permission issues:**

```bash
chmod +x scripts/*.sh launchd/goldfish-env.sh
```
