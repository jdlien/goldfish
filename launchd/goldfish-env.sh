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
