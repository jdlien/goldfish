# Changelog

Notable changes to Goldfish. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump can change behaviour).

## [0.2.0] - 2026-10-02

The headline: **Goldfish now drives OpenAI Codex as well as Claude Code**, chosen per channel.
Slack messages that used to be dropped (voice notes, "also send to channel" replies, scanned PDFs)
now reach the agent in a form it can use.

### Added

- **OpenAI Codex as a second agent backend.** An `AgentRunner` interface now sits between the daemon
  and the CLI, with `ClaudeRunner` and a new `CodexRunner` (via `@openai/codex-sdk`) behind it.
  - `GOLDFISH_BACKEND` (`claude` | `codex`), with per-channel routing through `GOLDFISH_BACKEND_BY_CHANNEL`.
  - Per-provider models: `GOLDFISH_CLAUDE_MODEL`, `GOLDFISH_CODEX_MODEL`, and their `_BY_CHANNEL` maps.
  - An explicit unattended policy for Codex: sandbox, network, web search, and extra writable roots.
  - A thread stays on the backend it started on, so a conversation never switches providers mid-thread.
  - `init` writes an `AGENTS.md` (Codex's entry point) alongside `CLAUDE.md`. Scheduled synthesis,
    `auth` and `initiate` understand both backends.
- **Voice messages are transcribed, not dropped.** A Slack voice note becomes the message text; an
  uploaded recording arrives with its transcript attached. Uses MacWhisper's `mw` CLI.
- **Scanned PDFs get a text layer on ingest.** Image-only PDFs are detected cheaply and OCR'd, and
  the agent gets a Markdown sidecar it can search. Low-confidence pages are flagged inline, because OCR
  output is legible for gist but not trustworthy character by character.
- **The agent knows who is talking and where.** Channel prompts carry the sender's name and the channel
  ID, plus an optional per-channel briefing (`GOLDFISH_CHANNEL_BRIEF`). With `GOLDFISH_OWNER_USER_ID`
  set, DMs from anyone other than the owner are annotated too.
- **`goldfish send` and `goldfish upload` stay in the conversation's thread by default.** The daemon
  exports `GOLDFISH_CHANNEL_ID` and `GOLDFISH_THREAD_TS` to the agent; `--no-thread` posts at top level.
- Result events carry token usage where the CLI reports it.

### Changed

- Attachment size cap raised from 20 MB to 50 MB.
- `GOLDFISH_MODEL` and `GOLDFISH_MODEL_BY_CHANNEL` are deprecated. They still work, as Claude-only
  aliases for `GOLDFISH_CLAUDE_MODEL` and `GOLDFISH_CLAUDE_MODEL_BY_CHANNEL`.
- Workspace prompt templates refer to "`CLAUDE.md` or `AGENTS.md`" instead of `CLAUDE.md` alone.

### Fixed

- Replies sent with "also send to channel" (`thread_broadcast`) were silently dropped. Message subtypes
  now go through a named allowlist with a regression test.
- A 403 on a file download posted Slack OAuth setup instructions into whatever channel it happened in.
  That advice now goes only to the owner.
- A numeric environment variable set to an empty string evaluated to `0`, which could set the
  attachment cap to zero bytes. Numeric settings are now parsed strictly.

### Security

- `.env.*` is ignored by git, so token-bearing backups of `.env` can't be committed by accident.

### Upgrading

- **Database migrations 004 and 005 run automatically on start.** They add provider-neutral session
  columns (backfilled from `claude_session_id`), a per-session run lease, and backend pinning. Older
  binaries ignore the new columns.
- **Tools the new features use.** Each is needed only for its own feature. Set their paths explicitly
  (`GOLDFISH_*_PATH`): under launchd the daemon's `PATH` may not include Homebrew, so a bare name
  can fail to resolve.
  - voice: MacWhisper's `mw` CLI (`GOLDFISH_MW_PATH`). If transcription fails, the message still
    arrives, with a marker that carries the audio file's path.
  - scanned PDFs: `ocrmypdf` + `tesseract`, `pdftotext` (poppler), and `qpdf`
  - Codex: `codex login`. Goldfish uses the CLI version pinned by `@openai/codex-sdk` unless
    `GOLDFISH_CODEX_PATH` is set.

### Known issues

- `scripts/daily-synthesis.sh` needs **bash 4 or later**. macOS ships bash 3.2, which can't parse it,
  and Goldfish runs whichever `bash` comes first in `PATH`. On a stock Mac the nightly synthesis fails
  until you `brew install bash` and make sure Homebrew's bin is first in the scheduler's `PATH`.

## 0.1.0 and earlier

Untagged. See the git history before this release.

[0.2.0]: https://github.com/jdlien/goldfish/compare/fa764d6...v0.2.0
