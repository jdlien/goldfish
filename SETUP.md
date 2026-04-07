# Goldfish Setup Guide

This guide is designed to be read by Claude Code. Paste this into a Claude Code session:

```
Set up Goldfish following the guide in SETUP.md
```

Claude will walk through each step, handle file creation, and tell you when it needs you to do something manually (like creating a Slack app).

---

## Step 1: Prerequisites

Verify these are installed:

```bash
node --version    # Node.js 20+
pnpm --version    # pnpm
claude --version  # Claude Code CLI
```

If anything is missing, install it before continuing.

## Step 2: Install Dependencies

```bash
cd /path/to/goldfish   # wherever you cloned the repo
pnpm install
pnpm run build
```

## Step 3: Create a Slack App

### Option A: From Manifest (Recommended)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From an app manifest**
2. Select your Slack workspace
3. Paste the contents of `slack-app-manifest.yaml` from this repo (switch to YAML mode if needed)
4. Review the summary and click **Create**
5. Go to **Install App** → **Install to Workspace**

Then grab your two tokens:

- **App-Level Token:** Go to **Basic Information** → **App-Level Tokens** → **Generate Token** with `connections:write` scope. This is your `SLACK_APP_TOKEN` (starts with `xapp-`).
- **Bot Token:** Go to **Install App** → copy the **Bot User OAuth Token**. This is your `SLACK_BOT_TOKEN` (starts with `xoxb-`).

### Option B: Manual Setup

<details>
<summary>Click to expand manual steps</summary>

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From scratch**
2. Name it whatever you want (e.g., "Goldfish", your agent's name)
3. Select your Slack workspace

#### Enable Socket Mode
- Go to **Socket Mode** in the left sidebar
- Toggle it **on**
- Create an app-level token with `connections:write` scope
- Copy the token — this is your `SLACK_APP_TOKEN` (starts with `xapp-`)

#### Set Bot Permissions
- Go to **OAuth & Permissions**
- Under **Bot Token Scopes**, add:
  - `app_mentions:read`
  - `channels:history`
  - `channels:read`
  - `chat:write`
  - `files:read`
  - `files:write`
  - `groups:history`
  - `groups:read`
  - `im:history`
  - `im:read`
  - `im:write`
  - `reactions:read`
  - `users:read`

#### Enable Events
- Go to **Event Subscriptions** → toggle **on**
- Under **Subscribe to bot events**, add:
  - `message.channels`
  - `message.groups`
  - `message.im`
  - `app_mention`

#### Install to Workspace
- Go to **Install App** → **Install to Workspace**
- Copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN` (starts with `xoxb-`)

</details>

## Step 4: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```env
SLACK_APP_TOKEN=xapp-1-...        # From Step 3 (Socket Mode token)
SLACK_BOT_TOKEN=xoxb-...          # From Step 3 (Bot OAuth token)
GOLDFISH_WORKSPACE=/path/to/your/workspace  # See Step 5
GOLDFISH_DM_CHANNEL_ID=           # Optional: channel for proactive messages
```

To find your DM channel ID: open a DM with the bot in Slack, click the channel name at the top, and copy the Channel ID from the modal.

## Step 5: Set Up Your Workspace

The workspace is a directory of markdown files that define your agent's identity, memory, and context. Goldfish ships with a starter template:

```bash
cp -r workspace-template ~/goldfish-workspace
```

Then edit `~/goldfish-workspace/CLAUDE.md` to define your agent's personality. This is the most important file — it's what makes your agent *yours*.

Update `GOLDFISH_WORKSPACE` in your `.env` to point at this directory.

## Step 6: Test

```bash
# Verify Slack connection
pnpm run cli auth test

# Start the bot (foreground, for testing)
pnpm run cli start
```

Send a DM to your bot in Slack. You should get a response. If you see "Listening for messages..." in the terminal, it's working.

## Step 7: Run as a Service (macOS)

To keep Goldfish running in the background, use the included launchd plists.

### Configure paths

Edit `launchd/goldfish-env.sh` — update `GOLDFISH_HOME` if you cloned somewhere other than `~/code/goldfish`:

```bash
export GOLDFISH_HOME="${GOLDFISH_HOME:-$HOME/code/goldfish}"
```

Edit `launchd/com.goldfish.daemon.plist` — update the `WorkingDirectory` with your actual absolute path (launchd can't expand `~`):

```xml
<key>WorkingDirectory</key>
<string>/Users/YOURUSERNAME/code/goldfish</string>
```

### Install and start

```bash
# Copy plists
cp launchd/*.plist ~/Library/LaunchAgents/

# Load the daemon (starts immediately and on every login)
launchctl load ~/Library/LaunchAgents/com.goldfish.daemon.plist

# Load maintenance jobs
launchctl load ~/Library/LaunchAgents/com.goldfish.daily-synthesis.plist
launchctl load ~/Library/LaunchAgents/com.goldfish.index-memory.plist
```

Proactive outreach (morning briefings, heartbeats, explorations) is handled by the scheduler — see [`docs/deployment-macos.md`](docs/deployment-macos.md) for setting up `schedule.yaml` with a single cron entry.

### Verify

```bash
launchctl list | grep goldfish
tail -f /tmp/goldfish-daemon.log
```

See [`docs/deployment-macos.md`](docs/deployment-macos.md) for the full deployment guide, troubleshooting, and launchd gotchas.

## What's Next

- **Customize your agent** — edit `~/goldfish-workspace/CLAUDE.md` to refine personality, add tools, set boundaries
- **Add focus items** — update `FOCUS.md` with what you're working on
- **Let memory accumulate** — the daily synthesis cron and FTS5 indexer build your agent's long-term memory automatically
- **Read the architecture** — [`docs/architecture.md`](docs/architecture.md) explains how everything fits together
- **Read the identity guide** — [`docs/agent-identity.md`](docs/agent-identity.md) for the philosophy behind the workspace pattern
