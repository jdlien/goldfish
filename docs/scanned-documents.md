# Scanned PDFs: giving them a text layer

**Status:** implemented 2026-09-17
**Trigger:** A user sent a 33 MB, 58-page scanned document. It was over the 20 MB cap,
so it never downloaded. Raising the cap got the file in and revealed the real
problem: it is 58 photographs of paper.

This is the third instance of one pattern, and naming it is the point:

| Arrives as | Agent can't | Converted on ingest to |
|---|---|---|
| HEIC | read it | JPEG (replaces original) |
| voice note / audio | read it | transcript (inlined / sidecar) |
| **scanned PDF** | **search it** | **text layer + markdown sidecar** |

---

## Measurements (real file, not estimates)

| | |
|---|---|
| Document | 58 pages, 33,028,660 bytes |
| `/Font` references | **0** — every page is an image XObject |
| `pdftotext` before | **0 real characters** (58 bytes: one form feed per page) |
| Detection cost | **118 ms** |
| `ocrmypdf --jobs 8` | **25.9 s** (~0.45 s/page, 551% CPU) |
| `pdftotext` after | **91,388 real characters** |
| Pages tesseract flagged | 14 |

**Detection is nearly free, so it runs on every PDF.** An image-only PDF yields
exactly one form feed per page and nothing else, so the test is real characters
per page with whitespace stripped. A born-digital PDF clears it by orders of
magnitude; a scan scores zero.

---

## Decisions

**OCR runs inline.** 26 s for 58 pages is inside what someone will wait for, and
a typical document is far smaller. It runs inside the per-session lock, so
`MAX_OCR_PAGES` (120) is a wall-clock budget wearing a page count, and there is
a per-message circuit breaker: once one OCR blows its deadline the rest are
skipped rather than each queuing behind a wedged process.

**The markdown is the attachment; the PDF is a path in the marker.** Reading a
31 MB PDF means rendering page images — the right tool for *checking* a figure
and the wrong one for *finding* it. So the agent gets cheap greppable text by
default and the page images when it needs to verify something.

**The original is preserved in every state**, including failure, so OCR can be
retried and a claim can be checked against the image it came from.

**`--skip-text`** leaves pages that already have text alone, so scanned exhibits
stapled to a typed contract keep their real text and only the scans are OCR'd.

---

## The provenance warning is load-bearing

OCR of a photocopied legal document is **legible for gist and wrong in the characters**.
A spot check of page 40 produced `Landiord`, `caricel`, `shail`, `itnmediately`,
`distain`, and one stretch of pure garbage — inside a paragraph about
termination rights and three months' rent becoming due. Anyone quoting a figure
or a date out of that without checking the page image is quoting an artifact.

So the markdown header says so in capitals, per-page flags are inline, and the
prompt marker carries the low-confidence count rather than burying it.

⚠️ **Two things about those flags:**

1. **They are tesseract's own, not a proxy.** A hand-rolled "junk character"
   heuristic scored the visibly mangled page 40 as *clean*, because its noise is
   stray full stops and apostrophes rather than exotic glyphs. The tool's
   judgement beat the invented one.
2. **They are not deterministic.** The same file flagged 11 pages on one run and
   14 on the next. Treat the list as advisory, never as a property of the
   document — and never as a whitelist for the unflagged pages.

---

## The trap that keeps recurring

**The daemon's PATH contains neither `/opt/homebrew/bin` nor `/usr/local/bin`.**
Read off the live process with `ps eww`, not assumed. Every external binary —
`ocrmypdf`, `pdftotext`, `qpdf`, and `mw` before them — must be invoked by
absolute path or it is ENOENT. This has now caused three separate incidents.

`runWithDeadline` was extracted from `AudioTranscriber` into `lib/runProcess.ts`
when this became the second caller. Its contract is the important part: it is
guaranteed to settle. `execFile`'s `timeout` is a signal, not a deadline, and a
promise that never settles holds the per-session lock forever.

---

## Out of scope

- Correcting the OCR. The flags say where to look; a human or a second model
  decides. That is deliberate — an agent silently "fixing" a figure it
  misread is worse than leaving it visibly wrong.
- OCR for images (PNG/JPEG of a document). Same toolchain would work; no one has
  sent one yet.
- Re-running at higher quality on demand. The agent has the original path and a
  shell; it can.
