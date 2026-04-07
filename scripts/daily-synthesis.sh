#!/bin/bash
# Daily memory synthesis — consolidates session transcripts into a narrative daily log.
# Called by the schedule runner (schedule.yaml) or manually.
#
# Environment variables:
#   GOLDFISH_WORKSPACE         — workspace path (default: ~/goldfish-workspace)
#   GOLDFISH_SYNTHESIS_MODEL   — Claude model to use (default: claude-sonnet-4-6)

set -euo pipefail

WORKSPACE="${GOLDFISH_WORKSPACE:-$HOME/goldfish-workspace}"
MODEL="${GOLDFISH_SYNTHESIS_MODEL:-claude-sonnet-4-6}"
MAX_INPUT_KB="${GOLDFISH_SYNTHESIS_MAX_KB:-200}"
DATE=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)
SESSION_LOG="${WORKSPACE}/memory/sessions/${DATE}.jsonl"
DAILY_FILE="${WORKSPACE}/memory/${DATE}.md"

# Skip if no sessions happened
if [ ! -f "$SESSION_LOG" ]; then
  echo "No sessions for ${DATE}, skipping"
  exit 0
fi

SESSION_COUNT=$(wc -l < "$SESSION_LOG")
EXISTING_CONTENT=""

# If the agent already wrote a daily file, include it as context
if [ -f "$DAILY_FILE" ]; then
  EXISTING_CONTENT=$(cat "$DAILY_FILE")
fi

# Truncate large session logs to avoid prompt/timeout issues.
# Default 200KB ≈ 50-60K tokens — plenty for a thorough synthesis.
SESSION_SIZE_KB=$(( $(wc -c < "$SESSION_LOG") / 1024 ))
if [ "$SESSION_SIZE_KB" -gt "$MAX_INPUT_KB" ]; then
  SESSION_DATA=$(tail -c "${MAX_INPUT_KB}k" "$SESSION_LOG")
  TRUNCATION_NOTE="(Transcript truncated: ${SESSION_SIZE_KB}KB total, showing last ${MAX_INPUT_KB}KB. Earlier conversations were omitted.)"
  echo "Warning: session log is ${SESSION_SIZE_KB}KB, truncating to last ${MAX_INPUT_KB}KB"
else
  SESSION_DATA=$(cat "$SESSION_LOG")
  TRUNCATION_NOTE=""
fi

# Build the synthesis prompt
PROMPT=$(cat <<PROMPT_EOF
Synthesize the day's conversations into a daily memory log.

Date: ${DATE}
Sessions today: ${SESSION_COUNT}
${TRUNCATION_NOTE}

## Existing daily notes (written during sessions):
${EXISTING_CONTENT:-"(none)"}

## Session transcripts:
${SESSION_DATA}

## Instructions:
Write a daily log for ${DATE} in the style of existing daily files in memory/.
- If substantial notes already exist, ADD to them (new sections, fill gaps) — don't rewrite what's already good
- If no existing notes, write the full daily narrative
- Include: key events, decisions, project progress, and anything worth remembering
- Use markdown with ## headers for major sections
- Note anything that should be followed up on
PROMPT_EOF
)

# Run from /tmp to avoid CLAUDE.md auto-discovery (prevents persona loading).
# --system-prompt: override default system prompt to prevent tool loops.
# --max-turns 10: generous budget — with no tools available, it should use 1.
cd /tmp
claude -p "$PROMPT" \
  --model "$MODEL" \
  --max-turns 10 \
  --dangerously-skip-permissions \
  --output-format text \
  --system-prompt "You are a memory synthesis assistant. Output ONLY the daily log in markdown. Do not use any tools. Do not ask questions. Just write the synthesis." \
  > "${DAILY_FILE}.tmp"
cd - > /dev/null

# Only replace if synthesis succeeded
if [ -s "${DAILY_FILE}.tmp" ]; then
  if [ -n "$EXISTING_CONTENT" ]; then
    # Append synthesis to existing file
    {
      echo ""
      echo ""
      echo "## Auto-Synthesis (1 AM)"
      echo ""
      cat "${DAILY_FILE}.tmp"
    } >> "$DAILY_FILE"
  else
    mv "${DAILY_FILE}.tmp" "$DAILY_FILE"
  fi
  rm -f "${DAILY_FILE}.tmp"
  echo "Daily synthesis complete for ${DATE} (${SESSION_COUNT} sessions)"
else
  echo "Synthesis produced empty output, keeping existing file"
  rm -f "${DAILY_FILE}.tmp"
fi
