#!/bin/bash
# Daily memory synthesis — consolidates session transcripts into a narrative daily log.
# Called by the schedule runner (schedule.yaml) or manually.
#
# The synthesis is written into a marker-delimited block at the END of the daily file.
# Reruns REPLACE that block instead of appending, so the job is idempotent and can never
# duplicate the hand-written memory above it. The model is asked for NEW sections only,
# and any section whose heading already exists in the hand-written notes is dropped
# before writing — prompt instruction plus a deterministic filter, because the prompt
# alone is a soft constraint on an LLM.
#
# Environment variables:
#   GOLDFISH_WORKSPACE         — workspace path (default: ~/goldfish-workspace)
#   GOLDFISH_SYNTHESIS_MODEL   — Claude model to use (default: claude-sonnet-4-6)
#   GOLDFISH_SYNTHESIS_MAX_KB  — max transcript KB fed to the model (default: 200)
#   GOLDFISH_SYNTHESIS_DATE    — date to synthesize (default: yesterday)
#   GOLDFISH_CLAUDE_BIN        — claude executable (default: claude); overridden in tests

set -euo pipefail

WORKSPACE="${GOLDFISH_WORKSPACE:-$HOME/goldfish-workspace}"
MODEL="${GOLDFISH_SYNTHESIS_MODEL:-claude-sonnet-4-6}"
MAX_INPUT_KB="${GOLDFISH_SYNTHESIS_MAX_KB:-200}"
CLAUDE_BIN="${GOLDFISH_CLAUDE_BIN:-claude}"
DATE="${GOLDFISH_SYNTHESIS_DATE:-$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)}"

SESSION_LOG="${WORKSPACE}/memory/sessions/${DATE}.jsonl"
DAILY_FILE="${WORKSPACE}/memory/${DATE}.md"

START_MARKER="<!-- goldfish:auto-synthesis:start -->"
END_MARKER="<!-- goldfish:auto-synthesis:end -->"

# Scratch lives outside memory/ so a crashed run never leaves a stray .tmp for the
# memory indexer to pick up.
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

# Skip if no sessions happened
if [ ! -f "$SESSION_LOG" ]; then
  echo "No sessions for ${DATE}, skipping"
  exit 0
fi

SESSION_COUNT=$(wc -l < "$SESSION_LOG" | tr -d ' ')

# --- Separate hand-written content from any previously generated synthesis block ------
# Only marker-delimited blocks are removed. Unmarked "## Auto-Synthesis" sections
# written before this fix are left alone on purpose: stripping to end-of-file could
# take hand-written notes appended after them. Those are the backfill's job, under
# human review.
HUMAN_FILE="${SCRATCH}/human.md"
if [ -f "$DAILY_FILE" ]; then
  node -e '
const fs = require("fs");
const text = fs.readFileSync(process.argv[1], "utf-8");
const stripped = text.replace(
  /\n*<!-- goldfish:auto-synthesis:start -->[\s\S]*?<!-- goldfish:auto-synthesis:end -->[^\n]*\n?/g,
  "\n"
);
process.stdout.write(stripped.replace(/\s+$/, ""));
' "$DAILY_FILE" > "$HUMAN_FILE"
else
  : > "$HUMAN_FILE"
fi
HUMAN_CONTENT=$(cat "$HUMAN_FILE")

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
Synthesize the day's conversations into daily memory notes.

Date: ${DATE}
Sessions today: ${SESSION_COUNT}
${TRUNCATION_NOTE}

## Notes already written during the day (for context — DO NOT reproduce these):
${HUMAN_CONTENT:-"(none)"}

## Session transcripts:
${SESSION_DATA}

## Instructions:
Write ONLY the sections that are MISSING from the notes above.
- Your output is APPENDED to those notes. Anything you restate becomes a duplicate.
- Never copy, quote, summarize, or lightly reword a topic the notes already cover.
- Cover only what the transcripts contain and the notes do not: missed events,
  decisions, project progress, follow-ups, moments worth remembering.
- Use \`## \` headers for each new section, in the style of the existing notes.
- Do NOT output a top-level \`# \` title — the file already has one.
- If the existing notes already cover everything of substance, output exactly:
  NOTHING_NEW
PROMPT_EOF
)

# Run from /tmp to avoid CLAUDE.md auto-discovery (prevents persona loading).
# --system-prompt: override default system prompt to prevent tool loops.
# --max-turns 10: generous budget — with no tools available, it should use 1.
RAW_FILE="${SCRATCH}/raw.md"
cd /tmp
"$CLAUDE_BIN" -p "$PROMPT" \
  --model "$MODEL" \
  --max-turns 10 \
  --dangerously-skip-permissions \
  --output-format text \
  --system-prompt "You are a memory synthesis assistant. You are writing sections that will be APPENDED to an existing daily log. Output ONLY new markdown sections that the existing notes do not already contain. Never restate existing content. Do not use any tools. Do not ask questions." \
  > "$RAW_FILE" 2>/dev/null || echo "Warning: synthesis command failed" >&2
cd - > /dev/null

if [ ! -s "$RAW_FILE" ]; then
  echo "Synthesis produced empty output, leaving ${DATE} file untouched"
  exit 0
fi

# --- Drop anything the hand-written notes already cover -------------------------------
# Belt and braces: the prompt asks for new sections only, this enforces it.
SYNTHESIS_FILE="${SCRATCH}/synthesis.md"
node -e '
const fs = require("fs");
const human = fs.readFileSync(process.argv[1], "utf-8");
const raw = fs.readFileSync(process.argv[2], "utf-8");

const norm = (line) => line.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
const existing = new Set(
  human.split("\n").filter((l) => /^##\s/.test(l)).map(norm)
);

const out = [];
let keep = true;
for (const line of raw.split("\n")) {
  if (/^#\s/.test(line)) {
    // Echoed document title — drop it and anything under it until a real section.
    keep = false;
    continue;
  }
  if (/^##\s/.test(line)) keep = !existing.has(norm(line));
  if (keep) out.push(line);
}

const cleaned = out
  .join("\n")
  .replace(/\bNOTHING_NEW\b/g, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

process.stdout.write(cleaned);
' "$HUMAN_FILE" "$RAW_FILE" > "$SYNTHESIS_FILE"

if [ ! -s "$SYNTHESIS_FILE" ]; then
  echo "Synthesis added nothing new for ${DATE}, leaving file untouched"
  exit 0
fi

# --- Write: hand-written content, then a fresh marker-delimited synthesis block -------
OUT_FILE="${SCRATCH}/out.md"
{
  if [ -n "$HUMAN_CONTENT" ]; then
    cat "$HUMAN_FILE"
    echo ""
    echo ""
  fi
  echo "$START_MARKER"
  echo "## Auto-Synthesis (1 AM)"
  echo ""
  cat "$SYNTHESIS_FILE"
  echo ""
  echo "$END_MARKER"
} > "$OUT_FILE"

mkdir -p "$(dirname "$DAILY_FILE")"
mv "$OUT_FILE" "$DAILY_FILE"
echo "Daily synthesis complete for ${DATE} (${SESSION_COUNT} sessions)"
