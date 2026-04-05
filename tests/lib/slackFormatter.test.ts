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

  it('trims whitespace at chunk boundaries', () => {
    const part1 = 'a'.repeat(3800);
    const part2 = 'b'.repeat(100);
    const text = `${part1}\n\n   ${part2}`;
    const result = splitSlackMessage(text);
    // Chunks should be trimmed
    for (const chunk of result) {
      expect(chunk).toBe(chunk.trim());
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
});
