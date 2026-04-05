import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../src/cli/initiate.js';

describe('buildPrompt', () => {
  it('builds morning check-in prompt', () => {
    const prompt = buildPrompt({ type: 'morning' });
    expect(prompt).toContain('Morning Check-in');
    expect(prompt).toContain('FOCUS.md');
    expect(prompt).toContain('CLAUDE.md');
  });

  it('builds weekly review prompt', () => {
    const prompt = buildPrompt({ type: 'weekly' });
    expect(prompt).toContain('Weekly Review');
  });

  it('includes reminder text in reminder mode', () => {
    const prompt = buildPrompt({
      type: 'morning',
      reminder: 'Call the dentist',
    });
    expect(prompt).toContain('Call the dentist');
    expect(prompt).toContain('reminder');
    // Should NOT contain the full briefing structure
    expect(prompt).not.toContain('FOCUS.md');
  });

  it('includes additional context when provided', () => {
    const prompt = buildPrompt({
      type: 'morning',
      context: 'Focus on the API migration today',
    });
    expect(prompt).toContain('Focus on the API migration today');
    expect(prompt).toContain('Additional Context');
  });

  it('omits context section when not provided', () => {
    const prompt = buildPrompt({ type: 'morning' });
    expect(prompt).not.toContain('Additional Context');
  });
});
