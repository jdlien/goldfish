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

# Build the synthesis prompt
PROMPT=$(cat <<PROMPT_EOF
Synthesize the day's conversations into a daily memory log.

Date: ${DATE}
Sessions today: ${SESSION_COUNT}

## Existing daily notes (written during sessions):
${EXISTING_CONTENT:-"(none)"}

## Session transcripts:
$(cat "$SESSION_LOG")

## Instructions:
Write a daily log for ${DATE} in the style of existing daily files in memory/.
- If substantial notes already exist, ADD to them (new sections, fill gaps) — don't rewrite what's already good
- If no existing notes, write the full daily narrative
- Include: key events, decisions, project progress, and anything worth remembering
- Use markdown with ## headers for major sections
- Note anything that should be followed up on
PROMPT_EOF
)

# Use Sonnet for synthesis
claude -p "$PROMPT" \
  --model "$MODEL" \
  --max-turns 3 \
  --dangerously-skip-permissions \
  --output-format text \
  > "${DAILY_FILE}.tmp"

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
