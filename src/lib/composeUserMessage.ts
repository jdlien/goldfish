/**
 * Assembles the final prompt text for a Slack message with attachments.
 *
 * This exists as a pure function, rather than inline in the message handler,
 * because the handler's attachment block had no test coverage and three
 * order-sensitive traps live in it:
 *
 *  - a voice note's audio path must never land in `attachmentPaths`, or the
 *    agent is handed an .m4a path its Read tool cannot open — the exact failure
 *    that transcribing was meant to avoid;
 *  - "was anything processed?" stops meaning `attachmentPaths.length === 0`
 *    once voice content exists, so the scope-missing early return would drop a
 *    perfectly good transcript;
 *  - a voice-only message has empty text and empty attachments, so appending
 *    voice content *after* the "nothing to send" guard silently discards it.
 *
 * Composing in one place, before any guard runs, makes all three structural
 * rather than a thing to remember.
 *
 * Markers state facts only. `start.ts` deliberately injects no instructional
 * prose — the agent's own identity files decide how it responds.
 */

export type VoiceState =
  /** Transcribed successfully; `transcript` is present. */
  | 'transcribed'
  /** The transcriber broke. */
  | 'failed'
  /** Ran fine, but the recording contained no words. */
  | 'no_speech'
  /** Longer than we're willing to transcribe inside the session lock. */
  | 'too_long'
  /** Duration could not be established, so we declined to try. */
  | 'unknown_duration';

export type AudioKind =
  /** Recorded in Slack. The transcript IS the message; it goes inline. */
  | 'voice'
  /** An uploaded recording. Genuinely an attachment; the transcript is a file. */
  | 'recording';

export interface VoiceMessagePart {
  kind: AudioKind;
  state: VoiceState;
  /** Where the audio lives. Present in every state, including failures. */
  audioPath: string;
  durationMs?: number;
  transcript?: string;
  /** Where the transcript was written. Only meaningful for 'recording'. */
  transcriptPath?: string;
}

export type DocumentState =
  /** Was a scan; now has a text layer and a markdown sidecar. */
  | 'ocr_added'
  /** Was a scan; OCR did not work. Still unsearchable. */
  | 'ocr_failed'
  /** Was a scan; too many pages to OCR inside the session lock. */
  | 'too_many_pages';

export interface DocumentPart {
  state: DocumentState;
  /** The PDF as it arrived. Always present, in every state. */
  originalPath: string;
  pageCount?: number;
  /** Searchable markdown. Cheap to read and greppable; the primary artifact. */
  markdownPath?: string;
  /** OCR'd PDF — page images preserved, for checking what the text claims. */
  ocrPdfPath?: string;
  /** Pages tesseract itself reported as low confidence. */
  lowConfidencePages?: number[];
}

export interface ComposeUserMessageInput {
  /** The user's typed text, if any. */
  text: string;
  /** Paths the agent can read directly. Never contains audio. */
  attachmentPaths: string[];
  voiceParts: VoiceMessagePart[];
  documentParts: DocumentPart[];
  /** Human-readable descriptions of files that couldn't be handled. */
  skipped: string[];
}

const VOICE_STATE_LABEL: Record<VoiceState, string> = {
  transcribed: 'auto-transcribed',
  failed: 'transcription failed',
  no_speech: 'no speech detected',
  too_long: 'too long to transcribe',
  unknown_duration: 'duration unknown, not transcribed',
};

/**
 * True when the message carries anything the agent can actually work with.
 *
 * Used by the scope-missing early return, which previously asked
 * `attachmentPaths.length === 0` — a question that became wrong the moment
 * voice content could arrive by another route.
 */
export function hasProcessedContent(
  input: Pick<
    ComposeUserMessageInput,
    'attachmentPaths' | 'voiceParts' | 'documentParts'
  >,
): boolean {
  return (
    input.attachmentPaths.length > 0 ||
    input.voiceParts.length > 0 ||
    input.documentParts.length > 0
  );
}

/**
 * A scanned PDF, and what we managed to do about it.
 *
 * The original path is carried in every state so the agent can retry OCR
 * itself, or look at a page image to check something the text claims. The
 * low-confidence count is surfaced rather than buried, because OCR of a
 * photocopy is legible for gist and wrong in the characters, and a figure
 * quoted out of it without that warning is an artifact presented as a fact.
 */
function renderDocumentPart(part: DocumentPart): string {
  const pages = part.pageCount ? `${part.pageCount} pages` : 'unknown length';

  if (part.state === 'ocr_added') {
    const confidence = part.lowConfidencePages?.length
      ? `${part.lowConfidencePages.length} page(s) LOW CONFIDENCE ` +
        `(${part.lowConfidencePages.join(', ')})`
      : 'no pages flagged';
    return (
      `[Scanned PDF · ${pages} · OCR'd, ${confidence} · ` +
      `searchable text: ${part.markdownPath} · ` +
      `page images: ${part.ocrPdfPath} · original: ${part.originalPath}]`
    );
  }

  const why =
    part.state === 'too_many_pages'
      ? 'too many pages to OCR'
      : 'OCR failed';
  return `[Scanned PDF · ${pages} · ${why}, no searchable text · original: ${part.originalPath}]`;
}

/** `19s`, `2m 5s`, `74m`, or `unknown length`. */
export function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return 'unknown length';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function renderVoicePart(part: VoiceMessagePart): string {
  const duration = formatDuration(part.durationMs);

  // An uploaded recording is not something the sender said into Slack, and a
  // nine-minute meeting is ~1500 words. Inlining it would both mislabel it as
  // speech addressed to the agent and duplicate the .txt it can already read.
  // So: marker only, and the transcript travels as an attachment.
  if (part.kind === 'recording') {
    const outcome =
      part.state === 'transcribed' && part.transcriptPath
        ? `transcribed to: ${part.transcriptPath}`
        : VOICE_STATE_LABEL[part.state];
    return `[Audio recording · ${duration} · ${outcome} · audio: ${part.audioPath}]`;
  }

  const header =
    `[Voice message · ${duration} · ` +
    `${VOICE_STATE_LABEL[part.state]} · audio: ${part.audioPath}]`;

  const transcript = part.transcript?.trim();
  if (part.state !== 'transcribed' || !transcript) {
    // A lone bracketed line is already self-delimiting; only a block with the
    // sender's words in it needs a closing marker.
    return header;
  }

  // Closing delimiter matches the `[end context]` convention already used for
  // the sender/room header, so the agent can tell where the sender's own words
  // stop and Goldfish's framing resumes.
  return `${header}\n${transcript}\n[end voice message]`;
}

export function composeUserMessage(input: ComposeUserMessageInput): string {
  const sections: string[] = [];

  const text = input.text.trim();
  if (text) sections.push(text);

  for (const part of input.voiceParts) {
    sections.push(renderVoicePart(part));
  }

  for (const part of input.documentParts) {
    sections.push(renderDocumentPart(part));
  }

  if (input.attachmentPaths.length > 0) {
    const label =
      input.attachmentPaths.length === 1 ? 'Attached file' : 'Attached files';
    sections.push(`[${label}: ${input.attachmentPaths.join(', ')}]`);
  }

  if (input.skipped.length > 0) {
    sections.push(`[Could not process: ${input.skipped.join(', ')}]`);
  }

  return sections.join('\n\n');
}
