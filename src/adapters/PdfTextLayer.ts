import { writeFile } from 'fs/promises';
import {
  type Result,
  ok,
  err,
  createError,
  ErrorCodes,
} from '../domain/services/result.js';
import { createChildLogger } from '../lib/logger.js';
import { runWithDeadline } from '../lib/runProcess.js';
import {
  PDFTOTEXT_BIN_PATH,
  QPDF_BIN_PATH,
  OCRMYPDF_BIN_PATH,
  MAX_OCR_PAGES,
  OCR_JOBS,
} from '../config.js';

const logger = createChildLogger('PdfTextLayer');

export interface OcrOutcome {
  /** Searchable markdown written beside the original. */
  markdownPath: string;
  /** The OCR'd PDF — images preserved, text layer added. */
  ocrPdfPath: string;
  pageCount: number;
  /** Pages tesseract itself reported as low confidence. */
  lowConfidencePages: number[];
}

/**
 * Gives a scanned PDF a text layer, then writes a reviewable markdown copy.
 *
 * Don's documents are photographs of paper — 58 pages, 58 image XObjects, zero
 * /Font references, nothing extractable. They download fine and are then
 * useless: not greppable, and "reading" them means rendering page images.
 *
 * Every binary is invoked by ABSOLUTE path. The daemon's PATH, read off the
 * live process, is the fnm node bin plus a few odds and ends — it does NOT
 * contain /opt/homebrew/bin or /usr/local/bin. A bare `ocrmypdf` is ENOENT.
 */
export class PdfTextLayer {
  /**
   * Text already extractable from the PDF. Cheap — 44ms on a 33MB file — so it
   * runs on every PDF before anything expensive is considered.
   */
  async extractText(pdfPath: string): Promise<string> {
    const run = await runWithDeadline(
      PDFTOTEXT_BIN_PATH,
      ['-layout', '-q', pdfPath, '-'],
      30_000,
    );
    return run.code === 0 ? run.stdout : '';
  }

  async pageCount(pdfPath: string): Promise<number | undefined> {
    const run = await runWithDeadline(
      QPDF_BIN_PATH,
      ['--show-npages', pdfPath],
      15_000,
    );
    if (run.code !== 0) return undefined;
    const n = Number(run.stdout.trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }

  /**
   * Is this a scan rather than a real document?
   *
   * pdftotext on an image-only PDF returns one form-feed per page and nothing
   * else — measured: 58 bytes for 58 pages. So the test is real characters per
   * page, with whitespace and page breaks stripped. A born-digital PDF clears
   * this by orders of magnitude; a scan scores zero.
   */
  needsOcr(extractedText: string, pageCount: number): boolean {
    const real = extractedText.replace(/[\s\f]/g, '');
    return real.length < pageCount * 20;
  }

  /**
   * Add a text layer and write the markdown sidecar.
   *
   * `--skip-text` leaves pages that already have text alone, so a mixed
   * document (scanned exhibits stapled to a typed contract) keeps its real text
   * and only the scans get OCR'd.
   */
  async addTextLayer(
    pdfPath: string,
    pageCount: number,
  ): Promise<Result<OcrOutcome>> {
    if (pageCount > MAX_OCR_PAGES) {
      return err(
        createError(
          ErrorCodes.PDF_OCR_TOO_LARGE,
          `${pageCount} pages exceeds the ${MAX_OCR_PAGES}-page OCR limit`,
        ),
      );
    }

    const ocrPdfPath = pdfPath.replace(/\.pdf$/i, '') + '.ocr.pdf';

    // Measured 28.8s for 58 pages at --jobs 8, so ~0.5s/page. Budget 3s/page
    // plus a floor: generous enough for a cold start and a slow scan, and it
    // still bounds the session lock.
    const deadlineMs = 60_000 + pageCount * 3_000;

    const run = await runWithDeadline(
      OCRMYPDF_BIN_PATH,
      [
        '--skip-text',
        '--output-type', 'pdf',
        '--jobs', String(OCR_JOBS),
        pdfPath,
        ocrPdfPath,
      ],
      deadlineMs,
    );

    if (run.timedOut || run.code !== 0) {
      logger.error(
        { pdfPath, pageCount, code: run.code, timedOut: run.timedOut },
        'ocrmypdf failed',
      );
      return err(
        createError(
          ErrorCodes.PDF_OCR_FAILED,
          run.timedOut
            ? `OCR exceeded ${deadlineMs}ms deadline`
            : `ocrmypdf exited ${run.code ?? 'null'}`,
          run.error,
        ),
      );
    }

    // Tesseract's OWN per-page confidence, parsed from its output. Using the
    // tool's judgement rather than a proxy: a hand-rolled "junk character"
    // heuristic scored a visibly mangled page as clean, because the noise was
    // stray full stops and apostrophes rather than exotic glyphs.
    const lowConfidencePages = parseLowConfidencePages(run.stderr + run.stdout);

    const text = await this.extractText(ocrPdfPath);
    if (!text.replace(/[\s\f]/g, '')) {
      return err(
        createError(
          ErrorCodes.PDF_OCR_FAILED,
          'OCR produced a PDF with no extractable text',
        ),
      );
    }

    const markdownPath = pdfPath.replace(/\.pdf$/i, '') + '.md';
    await writeFile(
      markdownPath,
      renderMarkdown(text, pdfPath, lowConfidencePages),
      'utf8',
    );

    logger.info(
      { pdfPath, markdownPath, pageCount, lowConfidence: lowConfidencePages.length },
      'PDF OCR complete',
    );

    return ok({ markdownPath, ocrPdfPath, pageCount, lowConfidencePages });
  }
}

/** ocrmypdf lines look like: `  40 [tesseract] lots of diacritics - possibly poor OCR` */
export function parseLowConfidencePages(output: string): number[] {
  const pages = new Set<number>();
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+\[tesseract\].*possibly poor OCR/.exec(line);
    if (m) pages.add(Number(m[1]));
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Markdown for a machine transcript of a scan.
 *
 * The provenance header is not decoration. OCR of a photocopied lease is
 * legible for gist and wrong in the characters — a spot check produced
 * "Landiord", "caricel", "shail", "distain". Anyone quoting a figure or a date
 * out of this without checking the page image will be quoting an artifact.
 */
export function renderMarkdown(
  text: string,
  sourcePath: string,
  lowConfidencePages: number[],
): string {
  const pages = text.split('\f');
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop();

  const flagged = new Set(lowConfidencePages);
  const name = sourcePath.split('/').pop() ?? sourcePath;

  const header = [
    `# ${name.replace(/\.pdf$/i, '')}`,
    '',
    '> ⚠️ **MACHINE OCR OF A SCANNED PDF. NOT A VERIFIED TRANSCRIPT.**',
    `> Source \`${name}\`, ${pages.length} pages.`,
    '>',
    lowConfidencePages.length
      ? `> **Tesseract flagged ${lowConfidencePages.length} page(s) as low confidence: ` +
        `${lowConfidencePages.join(', ')}.**`
      : '> Tesseract flagged no pages, which is not the same as being correct.',
    '>',
    '> Treat every figure, date, name and dollar amount as UNVERIFIED until',
    '> checked against the page image. Do not quote it verbatim to anyone.',
    '',
    '---',
    '',
  ];

  const body: string[] = [];
  pages.forEach((page, idx) => {
    const n = idx + 1;
    const content = page.replace(/\s+$/, '');
    const marks: string[] = [];
    if (flagged.has(n)) marks.push('⚠️ **LOW CONFIDENCE**');
    if (content.replace(/\s/g, '').length < 40) marks.push('⚠️ *almost no text recovered*');
    body.push(
      `## Page ${n}${marks.length ? '  ' + marks.join('  ') : ''}`,
      '',
      '```text',
      content.trim() ? content : '(no text recovered)',
      '```',
      '',
    );
  });

  return [...header, ...body].join('\n');
}
