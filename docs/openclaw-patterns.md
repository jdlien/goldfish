# Patterns Worth Porting from OpenClaw

*Exact file paths, line numbers, and algorithms for easy porting. All MIT-licensed.*

OpenClaw repo: `/mnt/user/appdata/openclaw-workspace/code/openclaw/`  
License: MIT (Copyright 2025 Peter Steinberger). Include notice if copying substantial code.

---

## 1. Render-Aware Message Splitting (PRIORITY: HIGH)

**Problem:** Slack has a 4,000-character limit per message. Long Claude responses get silently truncated. Our current `slackFormatter.ts` doesn't handle this.

**OpenClaw solution:** A chunking algorithm that splits markdown into pieces that each render within the limit, while preserving structure (bold spans, code blocks, links).

### Files

**Core algorithm:**
`src/markdown/render-aware-chunking.ts` (entire file, 327 lines)

- **Lines 26-64** — `renderMarkdownIRChunksWithinLimit()`: Main entry point. Takes a markdown IR, a character limit, a `renderChunk` function, and a `measureRendered` function. Iterates over pre-chunked pieces, checks if rendered output fits within limit, splits further if not.
  
- **Lines 93-113** — `findLargestChunkTextLengthWithinRenderedLimit()`: The key insight — rendered length is NOT monotonic (escaping, link rewriting can make shorter text render longer). So it tests exact candidates from longest to shortest, rendering each one, until it finds one that fits. Brute force but correct.

- **Lines 115-192** — `findMarkdownIRPreservedSplitIndex()`: Where to actually cut. Tracks parenthesis depth and prefers split points in this priority order:
  1. Newline outside parentheses (best — clean paragraph break)
  2. Whitespace outside parentheses
  3. Any newline
  4. Any whitespace
  5. Hard cut at limit (worst case)

- **Lines 214-261** — `mergeMarkdownIRChunks()` + adjacent merging: After splitting, merges whitespace-only chunks back into neighbors so you don't get messages that are just `\n`.

**Slack-specific rendering:**
`extensions/slack/src/format.ts`

- **Lines 139-158** — `markdownToSlackMrkdwnChunks()`: The Slack entry point. Calls `renderMarkdownIRChunksWithinLimit` with Slack's style markers (`*bold*`, `_italic_`, `` `code` ``, etc.) and `measureRendered: (rendered) => rendered.length`.

- **Lines 11-60** — `escapeSlackMrkdwnContent()`: Escapes `&`, `<`, `>` but preserves allowed Slack angle tokens (`<@user>`, `<#channel>`, `<!here>`, `<http://...>`, `<mailto:...>`, `<slack://...>`). Uses regex `/<[^>\n]+>/g` to find them, then tests with `isAllowedSlackAngleToken()` (lines 17-32).

- **Lines 107-119** — `buildSlackRenderOptions()`: Style marker map: bold=`*...*`, italic=`_..._`, strikethrough=`~...~`, code=`` `...` ``, code_block=` ```\n...``` `.

**Markdown IR system (dependency):**
`src/markdown/ir.ts` — The intermediate representation: `{ text: string, styles: StyleSpan[], links: LinkSpan[] }`. Functions: `markdownToIR()`, `sliceMarkdownIR()`, `chunkMarkdownIR()`, `renderMarkdownWithMarkers()`.

### Porting Strategy

Two options:

**A. Port the full IR system (~500 lines total):** Copy `ir.ts` + `render-aware-chunking.ts` + the Slack render options from `format.ts`. This gives you the complete solution — handles bold/italic span preservation across splits, link rewriting, the works.

**B. Simplified version (~50 lines):** Skip the IR system entirely. Split the *rendered* Slack mrkdwn output (post-formatting) at paragraph boundaries using the priority order from `findMarkdownIRPreservedSplitIndex`. Won't preserve formatting spans across splits but good enough for 95% of cases.

Recommendation: Start with (B), upgrade to (A) if agent responses regularly break formatting at split points.

### Simplified Implementation Sketch

```typescript
const SLACK_MSG_LIMIT = 3900; // Leave margin for Slack overhead

export function splitSlackMessage(text: string): string[] {
  if (text.length <= SLACK_MSG_LIMIT) return [text];
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > SLACK_MSG_LIMIT) {
    const slice = remaining.slice(0, SLACK_MSG_LIMIT);
    // Priority: last double-newline, then last newline, then last space
    let splitAt = slice.lastIndexOf('\n\n');
    if (splitAt < SLACK_MSG_LIMIT * 0.3) splitAt = slice.lastIndexOf('\n');
    if (splitAt < SLACK_MSG_LIMIT * 0.3) splitAt = slice.lastIndexOf(' ');
    if (splitAt < SLACK_MSG_LIMIT * 0.3) splitAt = SLACK_MSG_LIMIT;
    
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
```

---

## 2. Session-End Memory Capture (PRIORITY: MEDIUM)

**Problem:** Goldfish saves raw transcripts (JSONL) but doesn't auto-summarize session context when a conversation ends. OpenClaw generates descriptive filenames and extracts recent messages.

### Files

**Handler:**
`src/hooks/bundled/session-memory/handler.ts` (225 lines)

- **Lines 53-58** — Trigger: fires on `event.type === "command"` AND `event.action === "new" || "reset"`. Goldfish equivalent: fire when a session exceeds the expiry threshold, or add a `/save` Slack command.

- **Lines 127-132** — Message count: reads `hookConfig.messages` (default: 15). Extracts the last N messages from the session transcript for summarization.

- **Lines 137-158** — LLM slug generation: if session content exists and LLM is available, calls `generateSlugViaLLM({ sessionContent, cfg })` to create a descriptive filename. Falls back to `HHMM` timestamp (lines 162-164).

- **Lines 168-169** — Filename format: `${dateStr}-${slug}.md` → e.g., `2026-04-04-career-vision-thread.md`

- **Lines 184-206** — Output format: Markdown with header (`# Session: YYYY-MM-DD HH:MM:SS UTC`), metadata (session key, ID, source), and `## Conversation Summary` section with the extracted content.

**Transcript extraction:**
`src/hooks/bundled/session-memory/transcript.ts`

- `getRecentSessionContentWithResetFallback()` — reads the session JSONL, takes the last N messages, formats as readable text. Falls back to rotated reset transcripts if the current session is empty.
- `findPreviousSessionFile()` — when a session has been reset, finds the pre-reset file to capture what was said *before* the reset.

**LLM slug generator:**
`src/hooks/llm-slug-generator.ts`

- `generateSlugViaLLM()` — sends session content to a cheap model with a prompt like "generate a 3-5 word kebab-case slug describing this conversation." Returns e.g., `career-vision-thread` or `acp-debugging-night`.

### Porting Strategy

For Goldfish, the simplest approach: after the daily synthesis cron runs, use the Sonnet summary to generate a descriptive title for the daily file. We don't need per-session filenames since we use `YYYY-MM-DD.jsonl` (one file per day).

For a per-session `/save` command in Slack: extract the last 15 messages from the thread, send to Sonnet with "summarize and generate a slug", write to `memory/YYYY-MM-DD-{slug}.md`.

---

## 3. FTS5 Query Expansion (PRIORITY: MEDIUM)

**Problem:** Raw FTS5 `MATCH 'exact terms'` misses related content. A search for "career plan" won't find entries about "job strategy."

### Files

**Core logic:**
`packages/memory-host-sdk/src/host/query-expansion.ts`

- **Lines 746-772** — `extractKeywords()`: Tokenizes query → filters stop words → validates (min 3 chars for English, no pure numbers, no all-punctuation) → deduplicates. Returns clean keyword list.

- **Lines 781-797** — `expandQueryForFts()`: The key function. Takes user query, extracts keywords, returns `{ original, keywords, expanded }` where `expanded = "${original} OR ${keywords.join(' OR ')}"`. FTS5 gets both the original phrase AND individual keywords as OR alternatives.

- **Lines 633-643** — `isQueryStopWordToken()`: Checks against ~700+ stop words across English, Spanish, Portuguese, Arabic, Chinese, Korean, Japanese. (Overkill for us — we only need English.)

- **Lines 649-666** — `isValidKeyword()`: Rejects tokens < 3 chars (English), pure numbers (`/^\d+$/`), all-punctuation.

- **Lines 809-828** — `expandQueryWithLlm()`: Optional LLM-powered expansion. Sends query to model to extract semantic keywords. Falls back to local extraction if LLM fails. (Nice but not essential for MVP.)

### Porting Strategy

Strip out the multi-language support and just keep the English path:

```python
# In index-memory.py or a new query helper

STOP_WORDS = {"the", "a", "an", "is", "are", "was", "were", "be", "been",
              "being", "have", "has", "had", "do", "does", "did", "will",
              "would", "could", "should", "may", "might", "can", "shall",
              "about", "that", "this", "these", "those", "what", "which",
              "who", "whom", "how", "when", "where", "why", "not", "no",
              "and", "or", "but", "if", "then", "so", "for", "with",
              "from", "into", "to", "of", "in", "on", "at", "by"}

def expand_query(query: str) -> str:
    """Expand a search query for FTS5 with OR-joined keywords."""
    words = query.strip().split()
    keywords = [w for w in words if w.lower() not in STOP_WORDS and len(w) >= 3]
    if not keywords:
        return query
    return f"{query} OR {' OR '.join(keywords)}"
```

This is a 10-line function that catches 80% of the value. Add it to the search helper used from Claude Code sessions.

---

## 4. Slack Mention/Token Normalization (PRIORITY: LOW)

**Problem:** Slack wraps mentions in angle brackets (`<@U1234|username>`) and links in `<http://...|label>`. Need to handle these properly in both inbound (parsing) and outbound (preserving) directions.

### Files

**Inbound (stripping mentions for command detection):**
`extensions/slack/src/monitor/commands.ts:7-11`

```typescript
export function stripSlackMentionsForCommandDetection(text: string): string {
  return (text ?? "")
    .replace(/<@[^>]+>/g, " ")   // Remove <@USERID> or <@USERID|name>
    .replace(/\s+/g, " ")         // Normalize whitespace
    .trim();
}
```

**Outbound (preserving valid tokens during escaping):**
`extensions/slack/src/format.ts:15-32`

The regex `/<[^>\n]+>/g` matches all angle-bracket tokens. Then `isAllowedSlackAngleToken()` checks the inner content starts with `@`, `#`, `!`, `mailto:`, `tel:`, `http://`, `https://`, or `slack://`. Allowed tokens pass through unescaped; everything else gets `&lt;`/`&gt;` escaped.

**Bot mention detection:**
`extensions/slack/src/monitor/message-handler/prepare.ts:373-376`

```typescript
const isMentioned = /<@[^>]+>/.test(message.text);
const isExplicitlyMentioned = message.text?.includes(`<@${ctx.botUserId}>`);
```

### Porting Strategy

Two one-liners for Goldfish:
1. Strip mentions before passing to Claude: `text.replace(/<@[^>]+>/g, '').trim()`
2. When formatting outbound, preserve valid tokens (our `slackFormatter.ts` already converts `[text](url)` to `<url|text>` but doesn't handle the escaping properly for existing Slack tokens in Claude's output).

---

## Summary: Port Priority

| Pattern | Priority | Effort | Impact |
|---------|----------|--------|--------|
| Message splitting (4K limit) | HIGH | 1-2 hrs (simplified) | Prevents truncated responses |
| Session-end memory slug | MEDIUM | 1 hr | Better memory file naming |
| FTS5 query expansion | MEDIUM | 30 min | Better memory search |
| Slack token normalization | LOW | 15 min | Cleaner mention handling |

Total porting effort: ~half a day for all four, less if you skip the full IR system.

---

*OpenClaw is MIT licensed (Copyright 2025 Peter Steinberger). If copying substantial code blocks, include the LICENSE notice. Ideas and algorithms described here don't require attribution.*
