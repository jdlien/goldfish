# Goldfish — macOS Deployment

Run Goldfish as a persistent service on macOS using launchd + cron.

## Overview

Goldfish has two runtime components:

| Component | How it runs | Purpose |
|-----------|------------|---------|
| **Slack daemon** | launchd (always running) | Listens for Slack messages, spawns Claude sessions |
| **Scheduler** | cron (every minute) | Reads `schedule.yaml`, fires due tasks (briefings, heartbeats, etc.) |

### The scheduler (`schedule.yaml`)

Instead of managing individual launchd plists for each scheduled task, Goldfish
uses a single config file — the same pattern as Laravel's `schedule:run` but with subcommand syntax (`schedule run`):

```yaml
# schedule.yaml
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

  - name: weekly
    type: weekly
    at: "9am"
    days: sunday
    channel: C0A7FUF68PR
```

One cron entry drives all of it:

```
* * * * * cd ~/code/goldfish && node dist/index.js schedule run >> /tmp/goldfish-schedule.log 2>&1
```

Goldfish checks the config each minute and fires any matching tasks. Lock files
prevent overlapping runs of the same task.

#### Schedule syntax

| Field     | Example                          | Description                        |
|-----------|----------------------------------|------------------------------------|
| `at`      | `"8:30"`, `"8:30am"`, `"6pm"`   | Once a day at this time            |
| `every`   | `"hour"`, `"2 hours"`           | Repeating interval                 |
| `between` | `"10am-5pm"`, `"10:00-17:00"`   | Window constraint for `every`      |
| `days`    | `weekdays`, `weekends`, `monday`, `mon,wed,fri` | Which days to run |
| `cron`    | `"0 10-17 * * 1-5"`             | Raw cron — overrides all above     |

Times accept both 12-hour (`8:30am`, `6pm`) and 24-hour (`18:00`) formats.
`days` defaults to `daily` if omitted. `cron` is an escape hatch for anything
the human-readable syntax can't express.

Optional fields per task:
- `enabled: false` — disable a task without removing it
- `context: "..."` — extra context passed to the Claude prompt
- `channel` — which Slack channel to post to

#### Managing the schedule

```bash
goldfish schedule list              # Show all tasks and their cron expressions
goldfish schedule run               # Run any tasks due now
goldfish schedule run --dry-run     # Preview what would run
```

### Legacy: individual launchd plists

> **Note:** The launchd plists in `launchd/` predate the scheduler and are no
> longer the recommended approach for scheduled tasks. They still work if you
> prefer launchd, but `schedule.yaml` + one cron entry is simpler to manage.

The daemon plist (`com.goldfish.daemon`) is still the recommended way to run
the Slack listener — it needs launchd's `KeepAlive` for auto-restart on crash.

## Prerequisites

- Node.js 20+ and pnpm
- Claude Code CLI (`claude`) in PATH
- Slack app configured (see main README)
- `.env` file with Slack tokens and `GOLDFISH_WORKSPACE`

## Setup

### 1. Install dependencies and build

```bash
cd ~/code/goldfish
pnpm install
pnpm run build    # IMPORTANT: The daemon runs compiled JS, not tsx
```

> **Note:** You must run `pnpm run build` after any code changes. The daemon
> plist runs `node dist/index.js start` (compiled output), not the tsx dev
> server. If you skip the build step, the daemon will fail with MODULE_NOT_FOUND.

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your Slack tokens and workspace path
```

Required variables:
- `SLACK_APP_TOKEN` — Slack Socket Mode app-level token (`xapp-1-...`)
- `SLACK_BOT_TOKEN` — Slack bot OAuth token (`xoxb-...`)
- `GOLDFISH_WORKSPACE` — Absolute path to your agent workspace (containing `CLAUDE.md`, `SOUL.md`, `IDENTITY.md`, etc.)
- `GOLDFISH_DM_CHANNEL_ID` — Slack channel ID where proactive messages (briefings, heartbeat, exploration) are posted

### 3. Test the connection

```bash
pnpm cli auth test
```

You should see your workspace name, bot name, and Claude CLI version.

### 4. Copy LaunchAgent plists

```bash
cp launchd/*.plist ~/Library/LaunchAgents/
```

The plists reference `~/code/goldfish` as the install path. If your repo is
elsewhere, edit the plist files before copying. If you don't want the optional
services, omit them from the copy:

```bash
cp launchd/*.plist ~/Library/LaunchAgents/
```

### 5. Load the services

```bash
# Start the daemon (starts immediately and on every login)
launchctl load ~/Library/LaunchAgents/com.goldfish.daemon.plist
```

All scheduled tasks — proactive outreach (morning briefings, heartbeats, explorations)
and maintenance (daily synthesis, memory indexing) — are handled by `schedule.yaml`
with a single cron entry. See "The scheduler" section above.

### 6. Verify

```bash
# Check loaded services (daemon should show a PID; scheduled jobs will show "-")
launchctl list | grep goldfish

# Watch the daemon logs
tail -f /tmp/goldfish-daemon.log

# Inspect a scheduled job's state (runs count, last exit code, next fire time)
launchctl print gui/$(id -u)/com.goldfish.heartbeat
```

You should see "Goldfish started!" and "Listening for messages..." in the
daemon log. Send a DM to the bot in Slack to confirm it responds. To test a
scheduled job without waiting for its next fire time, use
`launchctl start com.goldfish.<service>` (see "Managing services" below).

## The `initiate` pattern

All proactive outreach types share a single CLI entrypoint:

```bash
pnpm cli initiate -t <type>
```

Supported types: `heartbeat`, `morning`, `weekly`, `exploration`.

Each type has its own prompt template in `src/cli/initiate.ts` that tells the
agent what to do. The plumbing (loading environment, spawning Claude, posting
to Slack, creating a session so thread replies continue the conversation) is
shared. Adding a new scheduled proactive task is usually:

1. Add a new case to `buildPrompt()` in `src/cli/initiate.ts`
2. Add the new type to the `InitiateOptions.type` union
3. Add a task entry in `schedule.yaml`
4. `pnpm run build`

No new scripts, no new runner code, no new database tables. The heartbeat has
one special behavior — if the agent's response starts with `HEARTBEAT_OK`, no
Slack message is sent at all — but everything else routes through the same
path.

## The exploration pattern

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

To adapt exploration for a different purpose, edit the `exploration` case in
`buildPrompt()` inside `src/cli/initiate.ts` and rewrite the prompt to tell the
agent what you want it to do. The plist stays the same.

## Shell environment (`goldfish-env.sh`)

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

## launchd gotchas

### Calendar jobs do NOT wake a sleeping machine, and missed runs are NOT queued

This is the single biggest thing to know. `StartCalendarInterval` (the cron
equivalent) has two behaviors that surprise people coming from Linux cron:

1. **It does not wake the machine.** If your Mac is asleep at 1:00 AM, the
   1:00 AM synthesis job is silently skipped.
2. **It does not queue missed runs.** When the Mac wakes up at 9:00 AM, launchd
   does *not* go back and fire the jobs it missed. They just wait for their
   next scheduled window.

Options if you need overnight jobs to run reliably:

- **Keep the machine awake.** `caffeinate -s` in a terminal, or disable sleep
  in System Settings → Displays & Energy.
- **Schedule a pmset wake event.** `sudo pmset repeat wakeorpoweron MTWRFSU 00:58:00`
  wakes the Mac at 00:58 every night, giving launchd a live machine at 1:00 AM.
- **Reschedule for waking hours.** Move the jobs to a time the machine is
  reliably on (e.g. 9:00 AM instead of 1:00 AM). This is the cheapest option
  and what most personal deployments should do.
- **Use `StartInterval` instead of `StartCalendarInterval`.** Interval-based
  jobs (every N seconds since load) tolerate sleep — they fire as soon as the
  machine wakes and the interval has elapsed. The heartbeat plist uses this
  approach. Downside: you give up "once a day at a specific time" semantics.

### LaunchAgents require an active login session

LaunchAgents run under your user, so they stop firing when you're logged out.
If you want Goldfish running while nobody is logged in, you'd need to move the
plists to `/Library/LaunchDaemons/` and run them as a system service — that
has its own setup and is not covered here.

### `runs = 0` is not necessarily a bug

If `launchctl print gui/$(id -u)/com.goldfish.daily-synthesis` shows
`runs = 0`, that means the job hasn't fired *since it was loaded*. If you
loaded it after its scheduled time today, it's correctly waiting for
tomorrow's window. Don't panic — check whether it had a chance to fire first.

## Managing services

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

# Run a scheduled job manually (for testing — does not affect its schedule)
launchctl start com.goldfish.daily-synthesis
launchctl start com.goldfish.heartbeat
launchctl start com.goldfish.exploration
```

## After code changes

When you update goldfish source code:

```bash
cd ~/code/goldfish
pnpm run build                      # Recompile TypeScript
launchctl stop com.goldfish.daemon  # launchd auto-restarts with new code
```

Scheduled jobs pick up new code automatically on their next fire — they spawn
a fresh node process each time and don't hold cached state.

## Logs

| Service | stdout | stderr |
|---------|--------|--------|
| Daemon | `/tmp/goldfish-daemon.log` | `/tmp/goldfish-daemon-err.log` |
| Synthesis | `/tmp/goldfish-synthesis.log` | `/tmp/goldfish-synthesis-err.log` |
| Index | `/tmp/goldfish-index.log` | `/tmp/goldfish-index-err.log` |
| Scheduler | `/tmp/goldfish-schedule.log` | (stderr in same file) |

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

**Scheduled jobs not firing:**
- Confirm they're loaded: `launchctl list | grep goldfish`
- Check `runs` counter: `launchctl print gui/$(id -u)/com.goldfish.<name> | grep runs`
- If `runs = 0`, the job hasn't had a chance to fire yet since being loaded —
  see "launchd gotchas" above
- If `runs > 0` but nothing happens, check the log files in `/tmp/`
- Test manually: `launchctl start com.goldfish.<name>` forces an immediate run
- Remember: LaunchAgents require an active login session

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
