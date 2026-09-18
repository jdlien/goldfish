import { describe, it, expect } from 'vitest';
import {
  PdfTextLayer,
  parseLowConfidencePages,
  renderMarkdown,
} from '../../src/adapters/PdfTextLayer.js';

describe('needsOcr', () => {
  const layer = new PdfTextLayer();

  // Measured on Don's real lease: pdftotext returned exactly 58 bytes for 58
  // pages — one form feed per page and not a single character of text.
  it('detects a pure scan', () => {
    expect(layer.needsOcr('\f'.repeat(58), 58)).toBe(true);
  });

  it('leaves a born-digital PDF alone', () => {
    const realPage = 'LEASE AGREEMENT between the Landlord and the Tenant. '.repeat(20);
    expect(layer.needsOcr([realPage, realPage].join('\f'), 2)).toBe(false);
  });

  // A scan with a stray page number or a header stamped on each page must not
  // read as "already has text".
  it('still OCRs a scan carrying a few stray characters per page', () => {
    expect(layer.needsOcr(Array(58).fill('- 9 -').join('\f'), 58)).toBe(true);
  });
});

describe('parseLowConfidencePages', () => {
  // Real ocrmypdf output from the 58-page lease run.
  const output = [
    '    27 [tesseract] lots of diacritics - possibly poor OCR',
    '    33 [tesseract] lots of diacritics - possibly poor OCR',
    '    40 [tesseract] lots of diacritics - possibly poor OCR',
    'Parsing 58 pages with HocrParser',
    'Postprocessing...',
    '    12 [tesseract] some other note entirely',
  ].join('\n');

  it('extracts the pages tesseract itself flagged', () => {
    expect(parseLowConfidencePages(output)).toEqual([27, 33, 40]);
  });

  it('returns sorted, deduplicated pages', () => {
    const dup = ['    40 [tesseract] possibly poor OCR', '    9 [tesseract] possibly poor OCR',
                 '    40 [tesseract] possibly poor OCR'].join('\n');
    expect(parseLowConfidencePages(dup)).toEqual([9, 40]);
  });

  it('returns nothing for clean output', () => {
    expect(parseLowConfidencePages('Postprocessing...\nDone')).toEqual([]);
  });
});

describe('renderMarkdown', () => {
  // Long enough to clear the "almost no text recovered" threshold — short test
  // pages trip it, which is the heuristic working, not a bug.
  const page = (n: string) =>
    `Page ${n}: the Landlord and the Tenant hereby agree to the following terms and conditions.`;
  const text = [page('one'), page('two'), page('three')].join('\f');

  it('warns that this is a machine transcript, not a record', () => {
    const md = renderMarkdown(text, '/att/lease.pdf', []);
    expect(md).toContain('NOT A VERIFIED TRANSCRIPT');
    expect(md).toContain('UNVERIFIED');
    // "nothing flagged" must not be allowed to read as "correct".
    expect(md).toContain('which is not the same as being correct');
  });

  it('marks the pages tesseract flagged', () => {
    const md = renderMarkdown(text, '/att/lease.pdf', [2]);
    expect(md).toContain('## Page 2  ⚠️ **LOW CONFIDENCE**');
    expect(md).toContain('## Page 1\n');
    expect(md).toContain('low confidence: 2');
  });

  it('flags a page where OCR recovered almost nothing', () => {
    const md = renderMarkdown('Real content here on page one.\f \f', '/att/x.pdf', []);
    expect(md).toContain('almost no text recovered');
    expect(md).toContain('(no text recovered)');
  });

  it('keeps one section per page and drops the trailing empty split', () => {
    const md = renderMarkdown('a\fb\fc\f', '/att/x.pdf', []);
    expect((md.match(/^## Page /gm) ?? []).length).toBe(3);
  });
});
