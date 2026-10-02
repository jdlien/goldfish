#!/bin/bash
# Thread synthesis — writes a per-thread memory summary when a conversation goes idle.
# Called by the scheduler when it detects idle sessions with unsynthesized activity.
#
# Arguments:
#   $1 — session ID
#   $2 — Slack channel ID
#   $3 — Slack thread timestamp (or "null" for DMs)
#   $4 — last_synthesized_at (Unix ms, or "null" if never synthesized)
#
# Environment variables:
#   GOLDFISH_WORKSPACE         — workspace path (default: ~/goldfish-workspace)
#   GOLDFISH_SYNTHESIS_BACKEND — claude or codex
#   GOLDFISH_SYNTHESIS_MODEL   — provider model override

set -euo pipefail

WORKSPACE="${GOLDFISH_WORKSPACE:-$HOME/goldfish-workspace}"
CLAUDE_MODEL="${GOLDFISH_SYNTHESIS_MODEL:-claude-sonnet-4-6}"
CODEX_MODEL="${GOLDFISH_SYNTHESIS_MODEL:-${GOLDFISH_CODEX_MODEL:-}}"
BACKEND="${GOLDFISH_SYNTHESIS_BACKEND:-${GOLDFISH_BACKEND:-claude}}"
EFFORT="${GOLDFISH_SYNTHESIS_EFFORT:-${GOLDFISH_EFFORT:-}}"
CLAUDE_BIN="${GOLDFISH_CLAUDE_BIN:-claude}"

SESSION_ID="$1"
CHANNEL_ID="$2"
THREAD_TS="${3:-null}"
LAST_SYNTH_AT="${4:-null}"

TODAY=$(date +%Y-%m-%d)
DAILY_FILE="${WORKSPACE}/memory/${TODAY}.md"
YESTERDAY=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)

# Use node to filter JSONL — reliable JSON parsing, no python3/jq dependency
TRANSCRIPT=$(node -e "
const fs = require('fs');
const path = require('path');

const channel = '$CHANNEL_ID';
const thread = '$THREAD_TS' === 'null' ? null : '$THREAD_TS';
const sinceMs = '$LAST_SYNTH_AT' === 'null' ? null : Number('$LAST_SYNTH_AT');

const files = [
  path.join('$WORKSPACE', 'memory', 'sessions', '$YESTERDAY.jsonl'),
  path.join('$WORKSPACE', 'memory', 'sessions', '$TODAY.jsonl'),
];

const lines = [];
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.slackChannel !== channel) continue;
      const entryThread = entry.slackThread || null;
      if (thread !== entryThread) continue;
      if (sinceMs) {
        const entryTime = new Date(entry.timestamp).getTime();
        if (entryTime < sinceMs) continue;
      }
      lines.push(line);
    } catch {}
  }
}
process.stdout.write(lines.join('\n'));
" 2>/dev/null) || true

# Skip if no relevant transcript lines found
if [ -z "$TRANSCRIPT" ]; then
  echo "No new transcript lines for session ${SESSION_ID}, skipping"
  exit 0
fi

# Truncate if very large
TRANSCRIPT_SIZE=${#TRANSCRIPT}
if [ "$TRANSCRIPT_SIZE" -gt 100000 ]; then
  TRANSCRIPT="${TRANSCRIPT: -100000}"
  echo "Warning: thread transcript truncated to last 100KB"
fi

# Load existing daily file for context (just headers + first lines for dedup)
EXISTING_HEADERS=""
if [ -f "$DAILY_FILE" ]; then
  EXISTING_HEADERS=$(grep "^##" "$DAILY_FILE" 2>/dev/null || true)
fi

PROMPT=$(cat <<PROMPT_EOF
Summarize the following conversation thread into daily memory notes.

Date: ${TODAY}

## Existing section headers (to avoid duplication):
${EXISTING_HEADERS:-"(none yet)"}

## Conversation transcript to summarize:
${TRANSCRIPT}

## Instructions:
- Write a concise summary of THIS conversation
- Focus on: key topics discussed, decisions made, action items, emotional moments worth remembering
- If an existing section header already covers this topic, output nothing (print "ALREADY_COVERED")
- Use ## headers for distinct topics within the conversation
- Write in a warm, personal style — these are memory notes, not meeting minutes
- Output ONLY the new section(s) to append
- Start with a ## header describing the conversation topic
PROMPT_EOF
)

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
RAW_FILE="${SCRATCH}/raw.md"
if [ -n "${GOLDFISH_AGENT_RUNNER_ENTRY:-}" ]; then
  AGENT_ARGS=("$GOLDFISH_AGENT_RUNNER_ENTRY" agent-run --backend "$BACKEND" --cwd "$SCRATCH" --timeout-ms 300000 --max-turns 3)
  if [ "$BACKEND" = "claude" ]; then
    AGENT_ARGS+=(--model "$CLAUDE_MODEL")
  elif [ -n "$CODEX_MODEL" ]; then
    AGENT_ARGS+=(--model "$CODEX_MODEL")
  fi
  if [ -n "$EFFORT" ]; then AGENT_ARGS+=(--effort "$EFFORT"); fi
  printf '%s' "$PROMPT" | "${GOLDFISH_AGENT_RUNNER_BIN:-${GOLDFISH_NODE_BIN:-node}}" "${AGENT_ARGS[@]}" > "$RAW_FILE" 2>/dev/null || true
elif [ "$BACKEND" = "codex" ]; then
  if [ -n "${GOLDFISH_CODEX_PATH:-}" ]; then
    CODEX_COMMAND=("$GOLDFISH_CODEX_PATH")
  else
    CODEX_ENTRY=$("${GOLDFISH_NODE_BIN:-node}" --input-type=module -e 'import {createRequire} from "node:module"; const r=createRequire(import.meta.resolve("@openai/codex-sdk")); process.stdout.write(r.resolve("@openai/codex/bin/codex.js"));')
    CODEX_COMMAND=("${GOLDFISH_NODE_BIN:-node}" "$CODEX_ENTRY")
  fi
  CODEX_ARGS=(exec --ephemeral --skip-git-repo-check --ignore-rules -s read-only -C "$SCRATCH" -o "$RAW_FILE" -c 'approval_policy="never"' -c 'web_search="disabled"')
  if [ -n "$CODEX_MODEL" ]; then
    CODEX_ARGS+=(-m "$CODEX_MODEL")
  fi
  if [ -n "$EFFORT" ]; then CODEX_ARGS+=(-c "model_reasoning_effort=\"$EFFORT\""); fi
  printf '%s' "$PROMPT" | "${CODEX_COMMAND[@]}" "${CODEX_ARGS[@]}" - >/dev/null 2>&1 || true
elif [ "$BACKEND" = "claude" ]; then
  cd "$SCRATCH"
  CLAUDE_ARGS=(-p "$PROMPT" --model "$CLAUDE_MODEL" --max-turns 3 --dangerously-skip-permissions --output-format text --tools '' --system-prompt "You are a memory synthesis assistant. Output ONLY new markdown sections to append to a daily log. Do not use any tools.")
  if [ -n "$EFFORT" ]; then CLAUDE_ARGS+=(--effort "$EFFORT"); fi
  "$CLAUDE_BIN" "${CLAUDE_ARGS[@]}" > "$RAW_FILE" 2>/dev/null || true
  cd - > /dev/null
else
  echo "Unsupported synthesis backend: $BACKEND" >&2
  exit 1
fi
SYNTHESIS=$(cat "$RAW_FILE" 2>/dev/null || true)

if [ -z "$SYNTHESIS" ] || [ "$SYNTHESIS" = "ALREADY_COVERED" ]; then
  echo "Thread synthesis: nothing new to add for session ${SESSION_ID}"
  exit 0
fi

# Append to daily file
{
  if [ -f "$DAILY_FILE" ]; then
    echo ""
    echo ""
  else
    echo "# $(date +%B) ${TODAY#*-}, $(date +%Y) — $(date +%A)"
    echo ""
  fi
  echo "$SYNTHESIS"
} >> "$DAILY_FILE"

echo "Thread synthesis complete for session ${SESSION_ID}"
