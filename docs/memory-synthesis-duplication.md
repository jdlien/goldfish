# Daily-Synthesis Duplication — Root Cause, Fix, and Backfill Proposal

**Status:** code fixed and Tier 1 backfill applied (2026-07-28). Tiers 2 and 3 remain
**proposed only** — no memory file has been modified.

---

## Root cause

`scripts/daily-synthesis.sh` fed the model the *entire* existing daily file and told it
to "ADD to them." The model reasonably returned the **merged document** — existing notes
plus new sections. The script then appended that merged document to the file it had just
read.

Two independent defects:

1. **Verbatim echo.** The output contract was ambiguous ("Output ONLY the daily log"),
   so the model returned everything, not the delta.
2. **Blind append.** `>> "$DAILY_FILE"` with no marker and no replacement, so every run
   accumulated another copy.

The sibling script `scripts/thread-synthesis.sh` never had this bug — it passes only the
existing `##` headings and says "Output ONLY the new section(s) to append." The daily
script has been brought in line with it.

## The fix

- Synthesis now lands in a marker-delimited block:
  `<!-- goldfish:auto-synthesis:start -->` … `<!-- goldfish:auto-synthesis:end -->`.
  Reruns **strip and replace** that block. No accumulation, ever.
- Prompt and system prompt both state the output is *appended* and must contain only
  sections the existing notes lack. `NOTHING_NEW` is an explicit valid answer.
- A deterministic post-filter drops any `##` section whose heading already exists in the
  hand-written notes, plus any echoed `#` document title. The prompt is a soft constraint
  on an LLM; this is the hard one.
- Empty or all-duplicate output → **the file is left untouched**.
- Scratch files moved to `mktemp -d` (a crashed run used to leave `memory/*.md.tmp`
  behind for the indexer to swallow).
- New env vars: `GOLDFISH_SYNTHESIS_DATE` (backfill/manual runs) and
  `GOLDFISH_CLAUDE_BIN` (test injection).

Regression coverage: `tests/scripts/dailySynthesis.test.ts` — 5 tests, including
run-twice-assert-byte-identical against a stub that deliberately echoes existing content.

**Deliberately NOT handled in the script:** unmarked legacy `## Auto-Synthesis` blocks.
Stripping "from that heading to end of file" would take any hand-written notes appended
below it. Legacy blocks are the backfill's problem, under human review.

---

## ⚠️ Scope is much larger than reported, and the obvious backfill is destructive

The bug was reported as "every daily file since roughly 2026-07-02." Measured reality:

| | |
|---|---|
| Affected files | **92** |
| Date range | **2026-04-05 → 2026-07-26** (not July — it starts in April) |
| Sections inside synthesis blocks | 1,089 |
| — byte-identical to a section above | **174** |
| — same heading, **different body** | **395** |
| — **exist only in the synthesis block** | **520** |
| Files whose synthesis block is pure duplicate | **2 of 92** |

**Deleting the synthesis blocks would destroy 520 sections of real memory.**

This is not a theoretical risk. Sampled from `memory/2026-04-07.md`, present *only* in the
synthesis block: `Anthropic Enshittification — Deep Dive` (~1,200 words: the OAuth
refresh-token findings, the steipete timeline, the Theo transcript analysis), plus 13 more
including `TPL Container Registry Down` and `Exploration: Shame vs. Guilt in Behavioral
Change`. None of it appears above the marker.

Why: on days when a session wrote sparse notes, the 1 AM job was doing genuine work —
it mined the transcripts and produced the only record of large parts of the day. The
duplication rode along with content worth keeping.

The 395 "same heading, different body" sections are the awkward middle. Spot-checking
suggests the synthesis version is often *more* detailed than the in-session note, so even
heading-matched removal can lose material. These need judgment, not a script.

---

## Proposed backfill — three tiers, stop after any of them

### ✅ Tier 1 — Fix search without touching a single file *(DONE 2026-07-28)*

The stated harm is search pollution. That can be fixed at index time, non-destructively.

`src/lib/memoryIndexer.ts` already chunks markdown by `##` heading and already computes
`hashText(chunk.text)`. It uses that hash for the embedding cache, not for dedup — so two
identical chunks yield one embedding but two search rows. Skipping a chunk whose text hash
has already been seen *within the same file* removes all 174 exact duplicates from search
results and touches nothing on disk.

Implemented as `dedupeChunks()` in `src/lib/memoryIndexer.ts`, applied before embedding so
duplicates cost neither an embedding call nor a search row. Matching ignores whitespace
differences only — reworded sections are kept, because which version is better is a
judgement call.

Indexing is incremental by file hash, which cannot detect a change to *chunking logic*, so
`index-memory` gained a `--force` flag for exactly this case.

**Result of the forced rebuild:** 785 files, 15,242 chunks, **373 duplicate chunks
skipped**, 0 same-file duplicates remaining. All 15,242 vectors came from cache — zero
embedding calls. Spot-checked that synthesis-only content survived: the
`Anthropic Enshittification` chunk is still the top FTS hit for that term.

- Risk: none to memory files. Reversible by reindexing from the pre-change backup.
- Backup taken: `/tmp/search.sqlite.bak-20260728-025623` (190 MB, delete once satisfied).

### Tier 2 — Retro-mark the legacy blocks *(non-destructive, optional)*

Wrap each existing `## Auto-Synthesis (1 AM)` block in the new markers. Deletes nothing;
just brings 92 files under the new script's management so any future rerun replaces
cleanly, and lets tooling identify machine-written vs hand-written provenance.

- Risk: low — insert-only, two comment lines per file.
- Requires: `git`-backed backup first (see below).

### Tier 3 — Remove the 174 byte-identical sections *(destructive, needs go-ahead)*

Only sections where heading **and** body are byte-identical to a section above. Never
touches the 395 reworded or the 520 unique ones.

- Requires: backup, per-file diff review before commit, and an explicit go-ahead.
- Honest assessment: this is cosmetic. Tier 1 already fixes search. Files stay ~35%
  redundant regardless because of the reworded sections. **My recommendation is to skip
  Tier 3** unless the redundancy is bothering you when you read the files directly.

### Not proposed

Any LLM-driven "merge the duplicates intelligently" pass. That points a model at
irreplaceable hand-written memory with permission to rewrite it, which is the same class
of mistake that caused this bug.

### Before Tier 2 or 3, regardless

```bash
cd ~/goldfish-workspace && git add -A && git commit -m "Pre-backfill snapshot"
cp -a memory "/tmp/memory-backup-$(date +%Y%m%d-%H%M%S)"
```

Then rebuild the index by running `scripts/index-memory.sh` (takes no arguments — it
rebuilds the FTS5 index; it's the same script the 1:15 AM cron entry calls).
