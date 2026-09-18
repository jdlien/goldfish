# Voice messages: making Goldfish hear

**Status:** plan (rev 2, post-review) · 2026-09-17
**Trigger:** A non-technical user sent their first Slack voice note in a shared channel. It was rejected
at the MIME allowlist, never downloaded, and surfaced to the agent as
`[Could not process: audio_message.m4a (unsupported type)]`.

Rev 2 incorporates an adversarial design review. Where a decision changed, the
original reasoning is kept so it isn't relitigated.

---

## 1. Why this matters more than it looks

Some people prefer talking to typing. The message that failed had `text: "please"` and
19 seconds of the actual request in the audio. If voice silently loses its
content, the sender gets a reply to the word "please" and concludes they were
ignored. They have no error they can act on.

`/usr/local/bin/mw` (MacWhisper CLI) has been on this machine since 2026-07-28.
Nothing has ever reached it.

---

## 2. What was measured, not assumed

Live Slack API and this machine, 2026-09-17, against a real voice note.

```
name: audio_message.m4a   mimetype: audio/mp4   filetype: m4a
subtype: slack_audio      size: 309514          duration_ms: 19101
url_private_download: .../files-tmb/<team>-<file>-<hash>/download/audio_message_audio.mp4
transcription: {"status":"none"}    is_transcription_region_supported: true
```

| Finding | Evidence | Consequence |
|---|---|---|
| **Slack's own transcription will never arrive** | `"none"` at ingest *and* still `"none"` an hour later via `files.info`, despite region support. Free plan. | We do our own. Don't poll for one. |
| **There is no API to write a transcript onto a file** | Probed live: `files.update`, `files.setTranscription`, `files.transcriptions.set`, `files.transcription.update`, `files.rename` all return `unknown_method`. `files.edit` returns `not_allowed_token_type` (exists, rejects bot tokens; it is the legacy snippet editor, not audio). | The transcript has to live in our reply. There is no native slot. |
| **`subtype: "slack_audio"` marks a voice note** | Present on the voice note, absent on the PNG and .txt in the same thread. | Primary signal, checked independently of mimetype. |
| **`duration_ms` is present on voice notes** | 19101. | Runtime guard. But see §5 — it is optional in general. |
| **URL is `files-tmb`, ends `.mp4` not `.m4a`** | Above. | Existing code already prefers `url_private_download`. Both facts look like bugs. Comment them. |
| **Slack's `size` ≠ bytes received** | Slack says 309514; authenticated GET returns **171187**. `files-tmb` is a transcode. | Pre-download size check is conservative, therefore safe. It is not measuring what you get. |
| **The existing download path works on audio unchanged** | `curl` + bot token → `200`, `ISO Media, MP4 Base Media v1`. | Only the allowlist changes. No new auth or fetch logic. |
| **Transcription is fast enough to run inline** | Pinned invocation (§4.2) on the real 19.1 s note: **0.50 s**, exit 0. | Synchronous. No queue, no async state. |
| **`mw` writes the transcript to *both* stdout and stderr** | stdout 138 B (transcript). stderr 183 B (a `Transcribing …` line **plus** the transcript). | Never parse either stream. Use `-o`. |
| **`mw` exits 1 cleanly on failure** | Missing file → 1. Non-audio (`/etc/hosts`) → 1. | Exit code is trustworthy. |
| **Daemon has the Aqua session `mw` needs** | `launchctl print gui/501/com.jdlien.goldfish.daemon` → `type = LaunchAgent`, `state = running`. | `mw` can drive MacWhisper.app from the daemon. |
| **Daemon `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`** | Same output, `default environment`. | `/usr/local/bin` is **not** on it. Absolute path required. This trap already cost two failures in Sept 2026. `/usr/bin/afinfo` *is* on it. |
| **`mw` flag defaults track MacWhisper's GUI state** | `mw transcribe --help`, verbatim: `--model` "Defaults to the currently selected model"; `--speakers` "Defaults to the app's setting"; `--timestamps` "Defaults to the style's own setting". | **The 0.50 s measurement is a measurement of today's GUI state.** Every relevant flag must be pinned — see §4.2. |
| **`afinfo` is a cheap duration probe** | `/usr/bin/afinfo` → `estimated duration: 19.082000 sec` in **24 ms**. | Fallback when Slack omits `duration_ms`. |

---

## 3. The design decision that shapes everything

**A voice note is not an attachment. It is the message body in a different encoding.**

The obvious fix — add `audio/*` to `SUPPORTED_MIMETYPES` — is wrong. It hands the
agent a path to an `.m4a` the Read tool cannot open. The agent would then have to
notice it is audio and shell out to `mw` itself: a wasted turn, and it fails
whenever the agent doesn't think of it.

So the transcript becomes **prompt content**, inlined, like typed text.

| File | Treatment |
|---|---|
| `subtype === 'slack_audio'` | Voice message. Transcript inlined as content. Audio path in the marker — **never** in `attachmentPaths`. |
| any other `audio/*` | Transcribe to a `.txt` sidecar. **Attach only the `.txt`**; audio path goes in a marker, for the same reason. |
| everything else | Unchanged. |

### Rules inherited from the existing code, and kept

1. **Do not delete the original.** `convertHeicToJpeg` deletes the `.heic` because
   the JPEG fully replaces it. A transcript does not replace audio — it has errors,
   and it is the agent's own retry path when the daemon's `mw` call fails.
2. **No instructional prose in the prompt.** `start.ts` states this explicitly.
   Markers state facts only; they never tell the agent what to say.

---

## 4. Implementation

### 4.1 `src/adapters/SlackFileDownloader.ts`

Accept and classify audio. **Does not transcribe.**

- `SlackFile` gains `subtype?`, `duration_ms?`. `DownloadedFile` gains
  `isVoiceMessage: boolean`, `durationMs?: number`.
- `isSupported()`: accept `subtype === 'slack_audio'` **independently of mimetype**
  (a client shipping a voice note as `video/mp4` must not be rejected before the
  subtype is consulted), plus `mimetype.startsWith('audio/')`.
- **Audio gets a neutral on-disk name**: `<Date.now()>-<file.id>.<ext>`, `ext`
  allowlisted from `filetype`. Sender-controlled names survive `sanitizeFilename`
  with `' " $ ` ; & | * ? [ ]` intact and then get handed to a GUI app whose string
  handling we don't control; and `sanitizeFilename` truncates at 200 UTF-16 units,
  not bytes, so a 200-CJK-character name is 600 bytes against a 255-byte
  `NAME_MAX` — the `.txt` sidecar adds four more. Neutral names kill both.
  `originalName` still carries the real name. **Non-audio naming is unchanged** —
  no churn on working behaviour.
- **Retry once on non-2xx for audio.** Every download measurement in §2 was made
  hours after the message; the daemon fetches ~1 s after the event, and whether the
  `files-tmb` transcode exists that early is unmeasured. One retry after ~1.5 s,
  then fall back to `url_private`. Log the HTTP status with the file id.
- Comment the `files-tmb` / `.mp4` / `size` gotchas where they bite.

### 4.2 `src/adapters/AudioTranscriber.ts` (new)

```
mw transcribe --model <MW_MODEL> --language <lang> --format txt
              --style transcript --no-speakers --no-timestamps
              --overwrite -o <audioPath>.txt <audioPath>
```

- **Absolute path** (§2).
- **Every default pinned.** Unpinned, JD opening MacWhisper to run a podcast on
  `large-v3` with diarization silently repoints every one of the sender's voice notes at a
  5–10× slower model, blows the timeout, and returns transcripts prefixed
  `Speaker 1:` which the agent then quotes back at him. Nothing in the daemon
  changed; nothing in the logs explains it. Default model:
  `parakeet-pro:nvidia_parakeet-v3_494MB` (from `mw models list`).
- `--style transcript` is not cosmetic: it also collapses the pause line-breaks the
  default style emits, which is what makes the transcript quotable (§6).
- **`-o`, not stdout** — `mw` duplicates the transcript across both streams. The
  `.txt` on disk is wanted anyway. Parent directory already exists.
- **`killSignal: 'SIGKILL'`, and a `Promise.race` hard deadline.** `execFile`'s
  `timeout` is not a deadline, it is a SIGTERM; if `mw` is blocked in an
  uninterruptible wait on MacWhisper.app (modal update prompt, licence nag, model
  download) it never dies, the promise never settles, and — see §5 — the session
  lock is never released. The race guarantees the transcriber always settles
  regardless of what the child does.
- **Timeout scales with duration**: `max(60_000, 30_000 + durationMs / 4)`. A flat
  60 s is sized for a 19 s clip on a *warm* app; a legal 10-minute note on a cold
  one would fail after doing most of the work.
- Non-zero exit, deadline, or missing output → `AUDIO_TRANSCRIPTION_FAILED`.
  Exit 0 with whitespace-only output → `AUDIO_NO_SPEECH` (§4.6). Never throws.
- ⚠️ Known and unfixed: killing `mw` does not cancel the job inside MacWhisper.app.
  A retry queues behind the orphan. Documented in the code, not solved.

### 4.3 `src/lib/composeUserMessage.ts` (new, pure)

```ts
composeUserMessage({ text, attachmentPaths, voiceBlocks, skipped }): string
```

**The review's best structural finding: `start.ts`'s attachment block has zero test
coverage, and it is exactly where the bugs are.** Adding branches inline reproduces
three traps:

- **Trap A.** Pushing the audio path into `attachmentPaths` for provenance puts an
  unreadable path in the Read-target list — the precise failure §3 exists to avoid.
- **Trap B.** `scopeMissing && attachmentPaths.length === 0` stops meaning "nothing
  processed" once voice blocks live in their own array. A message with a good voice
  note plus one 403'd file early-returns and **drops the transcript**.
- **Trap C.** `!userMessage.trim()` is order-sensitive. Append voice blocks after
  it — the natural place — and a voice-only message (`text: ""`) hits the guard and
  is discarded. The exact outcome this plan exists to prevent.

So the composition becomes a pure function with no network or GUI dependency, and
the three traps get direct tests. `start.ts` keeps orchestration only.

### 4.4 `src/domain/services/result.ts`

Add `AUDIO_TRANSCRIPTION_FAILED`, `AUDIO_NO_SPEECH`.

⚠️ **Do not reuse `TRANSCRIPT_WRITE_FAILED`.** That is the *session* transcript
(`TranscriptWriter.ts`, the Claude conversation log). Same English word, unrelated
concept.

### 4.5 `src/config.ts`

```ts
MW_BIN_PATH              = env ?? '/usr/local/bin/mw'
MW_MODEL                 = env ?? 'parakeet-pro:nvidia_parakeet-v3_494MB'
TRANSCRIBE_LANGUAGE      = env ?? 'en'          // 'auto' misdetects on short clips
MAX_TRANSCRIBE_DURATION_MS       = env ?? 10 * 60 * 1000   // per file
MAX_TRANSCRIBE_TOTAL_DURATION_MS = env ?? 15 * 60 * 1000   // per message
```

Numeric env reads must guard empty strings — `Number('')` is `0`, which would make
every note "too long". Existing `config.ts` pattern doesn't, but these are the knobs
most likely to be fiddled with.

**The per-message budget is not optional.** `MAX_ATTACHMENTS_PER_MESSAGE` is 10, so
a per-file cap alone permits 10 × 9 min 59 s ≈ 100 minutes of audio transcribed
sequentially inside the session lock — by any full workspace member.

**Missing `duration_ms` is not "unlimited."** Probe with `afinfo` (24 ms, on the
daemon's PATH). If that also fails, treat as unverifiable → attach-only, no `mw`.

### 4.6 `src/cli/start.ts`

Orchestration only. Compute `senderIsOwner` **before** the attachment block (it is
currently computed after, at line 380).

Markers — note the closing delimiter, matching the existing `[end context]`
convention, so the agent can tell where the sender's words stop:

```
[Voice message · 19s · auto-transcribed · audio: /path/…m4a]
…the transcribed text of what the sender actually said…
[end voice message]
```

```
[Voice message · 19s · transcription failed · audio: /path/…m4a]
[Voice message · 19s · no speech detected · audio: /path/…m4a]
[Voice message · 74m · too long to transcribe · audio: /path/…m4a]
```

`transcription failed` and `no speech detected` are deliberately different: the
first means the machine broke, the second means the mic caught nothing. the sender's next
action differs — re-send versus check the mic. Trim before testing emptiness;
`--format txt` plausibly emits a trailing newline.

**The scope-missing reply must not be posted to a non-owner.** Today a 403 produces
*"my Slack app is missing the `files:read` scope. Add it in the Goldfish app's OAuth
settings and reinstall"* — which, in a shared channel, is developer instructions delivered
to someone who cannot act on them. Gate the diagnostic text on `senderIsOwner`; everyone else gets a plain
apology. This is a live bug independent of voice.

Lowercase `mimetype` before `startsWith('audio/')` — `isSupported` lowercases,
`DownloadedFile.mimetype` is passed through in original case.

---

## 5. Failure modes

| Mode | Behaviour | Why acceptable |
|---|---|---|
| `mw` missing / wrong path | exit≠0 → failure marker + audio path | Loud. Agent can retry. |
| `mw` hangs unkillably | `Promise.race` deadline → failure marker; **lock still released** | The whole reason for the race. Without it, one hung call takes the thread down until a daemon restart nobody can see is needed. |
| Cold start exceeds deadline | duration-scaled deadline → failure marker + path | Loud. |
| JD logged out (no Aqua session) | `mw` fails → failure marker + path | Strictly better than today: the audio is on disk. Headless fallback (`~/.local/bin/mlx_whisper`) exists; **not built now.** |
| Over per-file or per-message cap | skip marker + path, no `mw` call | Lock protected. |
| `duration_ms` absent, `afinfo` fails | attach-only, no `mw` call | Fail closed. |
| `files-tmb` not ready at event time | one retry, then `url_private` | SPECULATIVE trigger, cheap insurance. |
| Silent recording | `no speech detected` | Distinguishable from breakage. |
| Slack enables its own transcription | ignored | Deliberate. §2. |

---

## 6. Quoting the transcript back (behaviour, not code)

A voice note leaves **zero text** in Slack, and Slack's transcription is off on this
plan. So the thread — for the sender, for the owner scrolling back, and for future agent sessions
reading channel history — is a waveform followed by an answer to an invisible
question. That last one is a continuity hole, and it settles the question: quote
always.

**This belongs in the workspace `CLAUDE.md`, not here and not in the prompt marker**
— `start.ts` forbids injected instructional prose, and this is behaviour. Two repos,
two halves.

The rule: **repunctuate, never reword.** Fix capitals, periods, obvious ASR
artifacts (`Chat GPT` → `ChatGPT`). Never summarize, rephrase or tighten — a quote
that has been smoothed into the agent's own phrasing stops being verification and
becomes the agent confirming its own misreading. Truncate long notes with an
ellipsis rather than condensing. Quote **once**, on the first reply to a given note,
not on every subsequent turn.

Placement: a markdown blockquote inside the streamed reply. `SlackNativeStreamer`
sends `markdown_text` via `chat.startStream`/`appendStream` and Slack renders
markdown natively while streaming, so `> …` works with zero new API surface. A
separate Block Kit `context` message would look better but needs a
`SlackBoltClient.sendMessage` signature change (it is `channel`/`text`/`thread_ts`
only), puts two notifications in front of the sender for one question, and can strand an
orphan transcript if the reply then fails.

---

## 7. Tests

`tests/adapters/SlackFileDownloader.test.ts` — **`it('rejects audio files')` (line
139) asserts the behaviour being removed. Replace, don't delete.** Add: `slack_audio`
→ `isVoiceMessage true`; `audio/mpeg` without subtype → `false`; `slack_audio` with
a non-audio mimetype still accepted; `durationMs` carried through; neutral on-disk
name for audio; original audio still on disk after download.

`tests/lib/composeUserMessage.test.ts` (new) — the three traps: voice-only message
is never discarded; voice path never in `attachmentPaths`; voice-present means "not
nothing" for the scope-missing predicate. Plus marker/delimiter shape.

`tests/adapters/AudioTranscriber.test.ts` (new) — mock `execFile`: exit 0 + file →
`ok`; exit 1 → failed; exit 0 + empty/whitespace → `AUDIO_NO_SPEECH`; missing output
→ failed; **absolute path used**; `--model`/`--no-speakers`/`--no-timestamps`/`-o`
all passed; deadline settles even when the child never exits.

No test may invoke the real `mw` — it drives a GUI app.

---

## 8. Out of scope

- **Slack video clips.** They will fail exactly as this voice note did, and `mw`
  handles video natively. Deliberately excluded because the `subtype` string for a
  video clip is **unverified** — guessing a magic value into the allowlist is how
  the next incident report gets written. Capture one sample, then add it.
- Speaker diarization — one person; costs time, buys nothing. Now explicitly *off*
  rather than merely unused (§4.2).
- Background/async transcription. 0.50 s measured. Revisit only if the cap rises.
- Headless engine fallback (`mlx_whisper`). Failure path is already loud.
- Goldfish *sending* voice.
- Cancelling an orphaned MacWhisper job (§4.2).
- **Unverified, one manual check:** whether a cold `mw` launches MacWhisper.app in
  the *foreground*, stealing focus on the host's screen every time a note arrives after
  the app has been quit. The app was warm during all measurements.
