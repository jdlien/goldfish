#!/bin/bash
# Morning briefing — spawns a proactive check-in and posts to Slack.
# Cron: 30 8 * * 1-5 /path/to/goldfish/scripts/morning-briefing.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GOLDFISH_DIR="$(dirname "$SCRIPT_DIR")"

cd "$GOLDFISH_DIR"
exec pnpm run cli initiate --type morning
