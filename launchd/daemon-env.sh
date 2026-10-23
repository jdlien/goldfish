#!/bin/bash
# daemon-env.sh: the environment for Goldfish running as a LaunchDaemon (on bun), in place of
# launchd/goldfish-env.sh, which sources the login shell and suits a LaunchAgent.
#
# It works as an exec wrapper, so the plists need no `bash -c "…"` quoting:
#   daemon-env.sh node dist/index.js start
#
# It does only what a daemon needs: require GOLDFISH_HOME and GOLDFISH_WORKSPACE (both set
# by the plist), load $GOLDFISH_HOME/.env, and pin Node 26. It never sources ~/.zprofile,
# ~/.zshrc or zoxide. pyenv is left out on purpose; add it only if a Goldfish tool needs it.
#
# Headless Claude Code auth: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) would live in
# $GOLDFISH_HOME/.env alongside the other secrets. Putting it there is Rachel's item; this script only loads that file.

set -euo pipefail

: "${HOME:?HOME must be set by the LaunchDaemon plist}"
: "${GOLDFISH_HOME:?GOLDFISH_HOME must be set by the LaunchDaemon plist}"
: "${GOLDFISH_WORKSPACE:?GOLDFISH_WORKSPACE must be set by the LaunchDaemon plist}"
export GOLDFISH_HOME GOLDFISH_WORKSPACE

if [ $# -eq 0 ]; then
    echo "daemon-env.sh: usage: daemon-env.sh <command> [args...]" >&2
    exit 64
fi

# Goldfish's own settings and secrets. set -a exports every variable the file assigns.
if [ -f "$GOLDFISH_HOME/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$GOLDFISH_HOME/.env"
    set +a
else
    echo "daemon-env.sh: WARN: $GOLDFISH_HOME/.env not found; continuing without it" >&2
fi

# Node: newest installed v26.x from fnm, first on PATH. The major version is pinned
# because better-sqlite3's native module is built for the Node 26 ABI. This is the same selection
# as goldfish-env.sh (macOS /usr/bin/sort supports -V).
node_bin=$(ls -d "$HOME"/.local/share/fnm/node-versions/v26.*/installation/bin 2>/dev/null \
    | sort -V | tail -n 1 || true)
if [ -z "$node_bin" ] || [ ! -x "$node_bin/node" ]; then
    echo "daemon-env.sh: FATAL: no Node v26.x under $HOME/.local/share/fnm/node-versions (install with: fnm install 26)" >&2
    exit 78
fi
export PATH="$node_bin:$PATH"

exec "$@"
