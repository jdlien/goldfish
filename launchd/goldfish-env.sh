#!/bin/bash
# Source the user's shell environment for launchd jobs.
# launchd runs with a minimal PATH, so we need to bootstrap fnm, pnpm, etc.

# Load the shell profile to get PATH, fnm, pyenv, etc.
if [ -f "$HOME/.zprofile" ]; then
  source "$HOME/.zprofile" 2>/dev/null
fi
if [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc" 2>/dev/null
fi

# --- Neutralize zoxide's directory-tracking hook ---
# Sourcing ~/.zshrc above also runs `eval "$(zoxide init zsh)"`, which registers
# __zoxide_hook in chpwd_functions. Nothing gates that on the shell being
# interactive, so it installs here too — and every plist runs `cd ~/code/goldfish`
# after sourcing this file. The scheduler fires every 60s, so that `cd` would call
# `zoxide add` 1440 times a day, pinning ~/code/goldfish at zoxide's 9999 rank
# ceiling. Because zoxide ages its database whenever total rank exceeds _ZO_MAXAGE
# (default 10000), one entry hogging the entire budget keeps the database
# permanently in aging mode and evicts every genuinely-used directory.
# Overriding the hook is shell-agnostic, so it covers the bash daemon too.
# See docs/deployment-macos.md, "Sourcing Your Shell Config Has Side Effects".
__zoxide_hook() { :; }

# Goldfish repo location — update this if you cloned somewhere else
export GOLDFISH_HOME="${GOLDFISH_HOME:-$HOME/code/goldfish}"

# Load .env from the goldfish repo
if [ -f "$GOLDFISH_HOME/.env" ]; then
  set -a
  source "$GOLDFISH_HOME/.env"
  set +a
fi

# Export workspace if not already set
export GOLDFISH_WORKSPACE="${GOLDFISH_WORKSPACE:-$HOME/goldfish-workspace}"

# --- Pin Node for Goldfish (see .node-version) ---
# Native modules (better-sqlite3) are compiled for a specific Node ABI.
# Letting fnm's *global* default jump to a new MAJOR (e.g. 26 -> 28) under
# the daemon breaks it with ERR_DLOPEN_FAILED. launchd runs non-interactively,
# so fnm's use-on-cd hook never fires — resolve the pinned major explicitly
# and put the newest installed patch of it first on PATH. Patch bumps within
# the major are ABI-compatible and picked up automatically; a MAJOR bump is
# deliberate: rebuild native modules (`pnpm rebuild`), then bump
# GOLDFISH_NODE_MAJOR and .node-version together.
GOLDFISH_NODE_MAJOR="26"
_gf_node_bin="$(ls -d "$HOME/.local/share/fnm/node-versions/v${GOLDFISH_NODE_MAJOR}".*/installation/bin 2>/dev/null | sort -V | tail -n 1)"
if [ -n "$_gf_node_bin" ] && [ -x "$_gf_node_bin/node" ]; then
  export PATH="$_gf_node_bin:$PATH"
fi
