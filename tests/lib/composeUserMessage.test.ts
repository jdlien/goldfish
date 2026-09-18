import { describe, it, expect } from 'vitest';
import {
  composeUserMessage,
  hasProcessedContent,
  formatDuration,
  type VoiceMessagePart,
} from '../../src/lib/composeUserMessage.js';

const voice = (o: Partial<VoiceMessagePart> = {}): VoiceMessagePart => ({
  kind: 'voice',
  state: 'transcribed',
  audioPath: '/att/2026-09-17/1-F1.m4a',
  durationMs: 19101,
  transcript: 'Sample transcribed speech for this test fixture.',
  ...o,
});

const base = { text: '', attachmentPaths: [], voiceParts: [], skipped: [] };

describe('formatDuration', () => {
  it('renders seconds, minutes, and unknown', () => {
    expect(formatDuration(19101)).toBe('19s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(4_440_000)).toBe('74m');
    expect(formatDuration(undefined)).toBe('unknown length');
    expect(formatDuration(0)).toBe('unknown length');
  });
});

describe('composeUserMessage — the three traps', () => {
  // Trap C: a voice-only message has empty text and empty attachments. If voice
  // content is folded in after the handler's "nothing to send" guard, it is
  // silently discarded — the exact failure this feature exists to prevent.
  it('a voice-only message is never empty', () => {
    const out = composeUserMessage({ ...base, voiceParts: [voice()] });
    expect(out.trim()).not.toBe('');
    expect(out).toContain('Sample transcribed speech');
  });

  it('a voice-only message is non-empty even when transcription failed', () => {
    const out = composeUserMessage({
      ...base,
      voiceParts: [voice({ state: 'failed', transcript: undefined })],
    });
    expect(out.trim()).not.toBe('');
    expect(out).toContain('transcription failed');
  });

  // Trap A: the audio path must never reach the list the agent treats as Read
  // targets — handing it an .m4a path is the failure transcription replaces.
  it('keeps the audio path out of the attachment list', () => {
    const out = composeUserMessage({
      ...base,
      attachmentPaths: ['/att/photo.png'],
      voiceParts: [voice()],
    });
    const attachedLine = out.split('\n').find((l) => l.startsWith('[Attached'));
    expect(attachedLine).toBe('[Attached file: /att/photo.png]');
    expect(attachedLine).not.toContain('.m4a');
    // ...but it is still present, in the voice marker, for retries.
    expect(out).toContain('audio: /att/2026-09-17/1-F1.m4a');
  });

  // Trap B: "was anything processed?" stopped meaning "attachmentPaths is
  // empty" the moment voice content could arrive by another route.
  it('counts voice content as processed content', () => {
    expect(hasProcessedContent({ attachmentPaths: [], voiceParts: [voice()] })).toBe(true);
    expect(hasProcessedContent({ attachmentPaths: ['/a.png'], voiceParts: [] })).toBe(true);
    expect(hasProcessedContent({ attachmentPaths: [], voiceParts: [] })).toBe(false);
  });
});

describe('composeUserMessage — rendering', () => {
  it('delimits the sender\'s words on both sides', () => {
    const out = composeUserMessage({ ...base, voiceParts: [voice()] });
    expect(out).toContain('[Voice message · 19s · auto-transcribed · audio: /att/2026-09-17/1-F1.m4a]');
    expect(out).toContain('[end voice message]');
  });

  it('omits the closing delimiter when there are no words', () => {
    for (const state of ['failed', 'no_speech', 'too_long', 'unknown_duration'] as const) {
      const out = composeUserMessage({
        ...base,
        voiceParts: [voice({ state, transcript: undefined })],
      });
      expect(out).not.toContain('[end voice message]');
    }
  });

  it('distinguishes a broken transcriber from a silent recording', () => {
    const failed = composeUserMessage({
      ...base,
      voiceParts: [voice({ state: 'failed', transcript: undefined })],
    });
    const silent = composeUserMessage({
      ...base,
      voiceParts: [voice({ state: 'no_speech', transcript: undefined })],
    });
    expect(failed).toContain('transcription failed');
    expect(silent).toContain('no speech detected');
    expect(failed).not.toEqual(silent);
  });

  it('treats a whitespace-only transcript as having no words', () => {
    const out = composeUserMessage({
      ...base,
      voiceParts: [voice({ transcript: '   \n  ' })],
    });
    expect(out).not.toContain('[end voice message]');
  });

  it('keeps typed text first, then voice, then attachments, then skips', () => {
    const out = composeUserMessage({
      text: 'please',
      attachmentPaths: ['/att/a.png', '/att/b.png'],
      voiceParts: [voice()],
      skipped: ['x.zip (unsupported type)'],
    });
    const order = [
      out.indexOf('please'),
      out.indexOf('[Voice message'),
      out.indexOf('[Attached files:'),
      out.indexOf('[Could not process:'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it('returns empty string when there is genuinely nothing', () => {
    expect(composeUserMessage(base)).toBe('');
  });
});

describe('composeUserMessage — uploaded recordings are not voice messages', () => {
  const recording = (o: Partial<VoiceMessagePart> = {}): VoiceMessagePart => ({
    kind: 'recording',
    state: 'transcribed',
    audioPath: '/att/meeting.mp3',
    durationMs: 9 * 60_000,
    transcript: 'a very long meeting transcript',
    transcriptPath: '/att/meeting.mp3.txt',
    ...o,
  });

  // The transcript of an uploaded file must NOT also be inlined: it is not
  // something the sender said into Slack, and duplicating ~1500 words that the
  // agent can already Read is waste on top of a mislabel.
  it('does not inline the transcript', () => {
    const out = composeUserMessage({ ...base, voiceParts: [recording()] });
    expect(out).not.toContain('a very long meeting transcript');
    expect(out).not.toContain('[end voice message]');
    expect(out).not.toContain('[Voice message');
  });

  it('labels it as a recording and points at the transcript', () => {
    const out = composeUserMessage({
      ...base,
      attachmentPaths: ['/att/meeting.mp3.txt'],
      voiceParts: [recording()],
    });
    expect(out).toContain('[Audio recording · 9m · transcribed to: /att/meeting.mp3.txt · audio: /att/meeting.mp3]');
    expect(out).toContain('[Attached file: /att/meeting.mp3.txt]');
  });

  it('still reports failure states for a recording', () => {
    const out = composeUserMessage({
      ...base,
      voiceParts: [recording({ state: 'failed', transcript: undefined, transcriptPath: undefined })],
    });
    expect(out).toContain('[Audio recording · 9m · transcription failed · audio: /att/meeting.mp3]');
  });

  it('never puts the audio path in the attachment list', () => {
    const out = composeUserMessage({
      ...base,
      attachmentPaths: ['/att/meeting.mp3.txt'],
      voiceParts: [recording()],
    });
    const attached = out.split('\n').find((l) => l.startsWith('[Attached'));
    expect(attached).not.toContain('.mp3]');
    expect(attached).not.toContain('.mp3,');
  });
});
