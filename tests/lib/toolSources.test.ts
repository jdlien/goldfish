import { describe, it, expect } from 'vitest';
import { extractToolSources } from '../../src/lib/toolSources.js';

describe('extractToolSources', () => {
  it('returns undefined when toolName is missing', () => {
    expect(extractToolSources(undefined, { url: 'x' }, '')).toBeUndefined();
  });

  it('returns undefined when tool has no sources (e.g. Bash)', () => {
    expect(
      extractToolSources('Bash', { command: 'ls' }, 'file1\nfile2'),
    ).toBeUndefined();
  });

  describe('WebFetch', () => {
    it('extracts the URL from input', () => {
      const sources = extractToolSources(
        'WebFetch',
        { url: 'https://example.com/article', prompt: 'summarize' },
        'irrelevant output',
      );
      expect(sources).toEqual([
        { type: 'url', url: 'https://example.com/article', text: 'https://example.com/article' },
      ]);
    });

    it('returns undefined when input has no url', () => {
      const sources = extractToolSources('WebFetch', { prompt: 'x' }, '');
      expect(sources).toBeUndefined();
    });
  });

  describe('WebSearch', () => {
    it('extracts URLs from the output text', () => {
      const output = `Results:
- First result: https://one.example.com/page
- Second: https://two.example.com/other
- Third: https://three.example.com`;
      const sources = extractToolSources('WebSearch', { query: 'test' }, output);
      expect(sources).toHaveLength(3);
      expect(sources?.[0].url).toBe('https://one.example.com/page');
      expect(sources?.[1].url).toBe('https://two.example.com/other');
      expect(sources?.[2].url).toBe('https://three.example.com');
    });

    it('deduplicates URLs', () => {
      const output = 'Source: https://a.com, also https://a.com again';
      const sources = extractToolSources('WebSearch', {}, output);
      expect(sources).toHaveLength(1);
    });

    it('strips trailing punctuation from URLs', () => {
      const output = 'See https://example.com/page. And https://other.com/x, yes';
      const sources = extractToolSources('WebSearch', {}, output);
      expect(sources?.[0].url).toBe('https://example.com/page');
      expect(sources?.[1].url).toBe('https://other.com/x');
    });

    it('caps at 10 sources', () => {
      const urls = Array.from({ length: 20 }, (_, i) => `https://site${i}.com`);
      const output = urls.join('\n');
      const sources = extractToolSources('WebSearch', {}, output);
      expect(sources).toHaveLength(10);
    });

    it('returns undefined when output has no URLs', () => {
      const sources = extractToolSources('WebSearch', {}, 'no links here');
      expect(sources).toBeUndefined();
    });
  });

  describe('defensive fallback for url in input', () => {
    it('extracts url from any tool input', () => {
      const sources = extractToolSources(
        'SomeCustomTool',
        { url: 'https://custom.example.com' },
        '',
      );
      expect(sources).toEqual([
        { type: 'url', url: 'https://custom.example.com', text: 'https://custom.example.com' },
      ]);
    });

    it('ignores non-string url fields', () => {
      const sources = extractToolSources(
        'SomeCustomTool',
        { url: { nested: 'x' } },
        '',
      );
      expect(sources).toBeUndefined();
    });
  });
});
