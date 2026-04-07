import { describe, it, expect } from 'vitest';
import { formatForSlack, splitSlackMessage } from '../../src/lib/slackFormatter.js';

describe('formatForSlack', () => {
  it('converts **bold** to *bold*', () => {
    expect(formatForSlack('**hello**')).toBe('*hello*');
  });

  it('converts multiple bold spans', () => {
    expect(formatForSlack('**one** and **two**')).toBe('*one* and *two*');
  });

  it('converts # headers to bold text', () => {
    expect(formatForSlack('# My Header')).toBe('*My Header*');
  });

  it('converts ## and ### headers', () => {
    expect(formatForSlack('## Sub Header')).toBe('*Sub Header*');
    expect(formatForSlack('### Sub Sub')).toBe('*Sub Sub*');
  });

  it('converts [text](url) links to <url|text>', () => {
    expect(formatForSlack('[click here](https://example.com)')).toBe(
      '<https://example.com|click here>',
    );
  });

  it('converts multiple links', () => {
    const input = '[a](https://a.com) and [b](https://b.com)';
    const expected = '<https://a.com|a> and <https://b.com|b>';
    expect(formatForSlack(input)).toBe(expected);
  });

  it('handles mixed formatting', () => {
    const input = '## **Bold Header**\n[link](https://x.com)';
    const result = formatForSlack(input);
    expect(result).toContain('*');
    expect(result).toContain('<https://x.com|link>');
  });

  it('passes through plain text unchanged', () => {
    expect(formatForSlack('just plain text')).toBe('just plain text');
  });

  it('returns empty string for empty input', () => {
    expect(formatForSlack('')).toBe('');
  });

  // =================================================================
  // Potential formatting edge cases that could cause display glitches
  // =================================================================

  it('handles bold text spanning multiple lines', () => {
    // Claude sometimes outputs bold across lines: **title\nsubtitle**
    const input = '**line one\nline two**';
    const result = formatForSlack(input);
    // Should either convert both lines or leave it alone — not eat content
    expect(result).toContain('line one');
    expect(result).toContain('line two');
  });

  it('handles bold text with asterisks inside', () => {
    const input = '**bold with *italic* inside**';
    const result = formatForSlack(input);
    expect(result).toContain('bold');
    expect(result).toContain('italic');
    expect(result).toContain('inside');
  });

  it('preserves blank lines between paragraphs', () => {
    const input = 'Paragraph 1.\n\nParagraph 2.\n\nParagraph 3.';
    const result = formatForSlack(input);
    expect(result).toBe(input); // plain text should pass through unchanged
  });

  it('does not squish header and following paragraph', () => {
    const input = '## Header\n\nParagraph text here.';
    const result = formatForSlack(input);
    expect(result).toContain('\n\n');
    expect(result).toContain('Paragraph text here.');
  });

  it('handles consecutive headers', () => {
    const input = '## Header 1\n## Header 2';
    const result = formatForSlack(input);
    expect(result).toBe('*Header 1*\n*Header 2*');
  });

  it('does not mangle code blocks', () => {
    const input = 'Before\n```\ncode here\n```\nAfter';
    const result = formatForSlack(input);
    expect(result).toContain('code here');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('handles bold markers at line boundaries', () => {
    // Could cause lines to merge if regex eats the newline
    const input = 'Text **bold**\nNext line';
    const result = formatForSlack(input);
    expect(result).toBe('Text *bold*\nNext line');
  });

  it('converts a simple table to a row-based format', () => {
    const input = [
      '| Name | Value |',
      '|------|-------|',
      '| Alice | 42 |',
      '| Bob | 99 |',
    ].join('\n');

    const result = formatForSlack(input);
    // Header row rendered bold with middle-dot separators
    expect(result).toContain('*Name*  ·  *Value*');
    // Data rows use the same separator, no bold
    expect(result).toContain('Alice  ·  42');
    expect(result).toContain('Bob  ·  99');
    // Separator row is stripped
    expect(result).not.toContain('|---|');
  });

  it('converts a three-column table', () => {
    const input = [
      '| A | B | C |',
      '|---|---|---|',
      '| 1 | 2 | 3 |',
    ].join('\n');

    const result = formatForSlack(input);
    expect(result).toContain('*A*  ·  *B*  ·  *C*');
    expect(result).toContain('1  ·  2  ·  3');
  });

  it('preserves text around tables', () => {
    const input = 'Before\n| A | B |\n|---|---|\n| 1 | 2 |\nAfter';
    const result = formatForSlack(input);
    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).toContain('*A*  ·  *B*');
    expect(result).toContain('1  ·  2');
  });

  it('does not mangle lines with pipes that are not tables', () => {
    const input = 'this is a | pipe in text';
    expect(formatForSlack(input)).toBe('this is a | pipe in text');
  });
});

describe('splitSlackMessage', () => {
  it('returns single element for short text', () => {
    const result = splitSlackMessage('hello');
    expect(result).toEqual(['hello']);
  });

  it('returns single element for text exactly at limit', () => {
    const text = 'a'.repeat(3900);
    const result = splitSlackMessage(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it('splits text exceeding limit', () => {
    const text = 'a'.repeat(4000);
    const result = splitSlackMessage(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join('').length).toBe(4000);
  });

  it('prefers splitting at paragraph boundaries', () => {
    const para1 = 'a'.repeat(2000);
    const para2 = 'b'.repeat(2000);
    const text = `${para1}\n\n${para2}`;
    const result = splitSlackMessage(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(para1);
    expect(result[1]).toBe(para2);
  });

  it('falls back to line breaks when no paragraph break', () => {
    const line1 = 'a'.repeat(2000);
    const line2 = 'b'.repeat(2000);
    const text = `${line1}\n${line2}`;
    const result = splitSlackMessage(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(line1);
    expect(result[1]).toBe(line2);
  });

  it('falls back to spaces', () => {
    const word = 'a'.repeat(1950);
    const text = `${word} ${word} ${word}`;
    const result = splitSlackMessage(text);
    expect(result.length).toBeGreaterThan(1);
    // No chunk should exceed the limit
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(3900);
    }
  });

  it('hard-splits when no whitespace found', () => {
    const text = 'a'.repeat(8000);
    const result = splitSlackMessage(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join('').length).toBe(8000);
  });

  it('trims incidental whitespace at chunk boundaries', () => {
    const part1 = 'a'.repeat(3800);
    const part2 = 'b'.repeat(100);
    const text = `${part1}\n\n   ${part2}`;
    const result = splitSlackMessage(text);
    // Trailing spaces on chunks should be trimmed
    for (const chunk of result) {
      expect(chunk).toBe(chunk.trimEnd());
    }
  });

  it('handles empty string', () => {
    const result = splitSlackMessage('');
    expect(result).toEqual(['']);
  });

  it('handles multiple splits for very long text', () => {
    const text = ('word '.repeat(1000)).trim(); // ~5000 chars
    const result = splitSlackMessage(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(3900);
    }
  });

  // =================================================================
  // BUG: splitSlackMessage destroys paragraph breaks at split points.
  // trimEnd()/trimStart() on chunks eats the \n\n that separates
  // paragraphs, causing words to run together when Slack renders them.
  // =================================================================

  it('preserves paragraph break when split falls on a double newline', () => {
    // Two paragraphs that together exceed the limit, split at the \n\n
    const para1 = 'a'.repeat(3000);
    const para2 = 'b'.repeat(2000);
    const text = `${para1}\n\n${para2}`;
    const result = splitSlackMessage(text);

    expect(result).toHaveLength(2);
    // When rejoined, the paragraph break must still exist
    const rejoined = result.join('\n\n');
    expect(rejoined).toContain('\n\n');
    // Neither chunk should start with content from the other paragraph
    expect(result[0]).not.toContain('b');
    expect(result[1]).not.toContain('a');
  });

  it('does not squish words together at split boundaries', () => {
    // Simulate a response that splits at a line break between sentences
    const sentence1 = 'End of first section.';
    const padding = 'x'.repeat(3900 - sentence1.length - 1); // fill to just before limit
    const sentence2 = 'Start of next section.';
    const text = `${padding}${sentence1}\n${sentence2}`;
    const result = splitSlackMessage(text);

    expect(result.length).toBeGreaterThanOrEqual(2);
    // The second chunk must not lose its leading content
    const lastChunk = result[result.length - 1];
    expect(lastChunk).toContain('Start of next section.');
  });

  it('preserves single newline between lines at split boundary', () => {
    const line1 = 'a'.repeat(3895);
    const line2 = 'Next line here';
    const text = `${line1}\n${line2}`;
    const result = splitSlackMessage(text);

    expect(result).toHaveLength(2);
    // Second chunk should start with the actual content, not be empty
    expect(result[1]).toBe(line2);
  });

  it('reconstructed text preserves all content after multiple splits', () => {
    const para1 = 'First paragraph. '.repeat(100).trim();  // ~1700 chars
    const para2 = 'Second paragraph. '.repeat(100).trim(); // ~1800 chars
    const para3 = 'Third paragraph. '.repeat(100).trim();  // ~1700 chars
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    const result = splitSlackMessage(text);

    // All content words must appear in the output
    const rejoined = result.join('\n\n');
    expect(rejoined).toContain('First paragraph.');
    expect(rejoined).toContain('Second paragraph.');
    expect(rejoined).toContain('Third paragraph.');
  });
});
