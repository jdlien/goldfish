import chalk from 'chalk';
import path from 'node:path';
import { withBrowser, USER_DATA_DIR } from '../browser/index.js';

/**
 * `goldfish browser login` — launch a visible browser so the user can log into
 * sites manually. Cookies persist in the shared userDataDir; after this,
 * headless runs can reuse the sessions.
 *
 * The command exits when the user closes the browser window (or all pages).
 */
export async function browserLogin(): Promise<void> {
  console.log(chalk.cyan('Launching patched Chromium (headful)…'));
  console.log(chalk.dim(`Profile: ${USER_DATA_DIR}`));
  console.log(
    chalk.yellow(
      'Log into whatever sites you want Goldfish to have access to ' +
        '(LinkedIn, GitHub, paywalls…). Close the window when done.'
    )
  );

  await withBrowser(
    async (ctx) => {
      // Open a blank starter tab if none exists, so there's something visible.
      const pages = ctx.pages();
      if (pages.length === 0) {
        await ctx.newPage();
      }

      // Wait until the user closes the context (last window closed).
      await new Promise<void>((resolve) => {
        ctx.on('close', () => resolve());
      });
    },
    { headless: false }
  );

  console.log(chalk.green('✓ Browser closed. Session saved.'));
}

export interface BrowserGotoOptions {
  url: string;
  /** Output format: rendered text (default) or full HTML. */
  format?: 'text' | 'html';
  /**
   * Wait for full network idle before extracting. Default: false.
   * Many modern sites (GitHub, Gmail, LinkedIn) hold open long-poll
   * connections that never go idle — enable only when you know the site
   * finishes loading cleanly.
   */
  waitNetworkIdle?: boolean;
}

/**
 * `goldfish browser goto <url>` — navigate to a URL and print the rendered
 * page content to stdout. Uses the persistent profile so logged-in sessions
 * are available.
 */
export async function browserGoto({
  url,
  format = 'text',
  waitNetworkIdle = false,
}: BrowserGotoOptions): Promise<void> {
  const content = await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(url, {
      waitUntil: waitNetworkIdle ? 'networkidle' : 'domcontentloaded',
      timeout: 45_000,
    });
    // Brief settle delay so client-rendered content has a chance to paint.
    if (!waitNetworkIdle) {
      await page.waitForTimeout(1500);
    }
    if (format === 'html') {
      return await page.content();
    }
    return await page.evaluate(() => document.body?.innerText ?? '');
  });
  process.stdout.write(content);
  if (!content.endsWith('\n')) process.stdout.write('\n');
}

export interface BrowserScrapeOptions {
  url: string;
  selector: string;
  /** Return `innerText` (default) or `outerHTML` for each match. */
  attr?: 'text' | 'html';
}

/**
 * `goldfish browser scrape <url> <selector>` — navigate to a URL and print
 * every element matching the CSS selector, one per line, separated by a
 * delimiter for easy parsing.
 */
export async function browserScrape({
  url,
  selector,
  attr = 'text',
}: BrowserScrapeOptions): Promise<void> {
  const results = await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1500);
    return await page.$$eval(
      selector,
      (els, mode) =>
        els.map((el) =>
          mode === 'html' ? (el as HTMLElement).outerHTML : (el as HTMLElement).innerText
        ),
      attr
    );
  });

  if (results.length === 0) {
    console.error(chalk.yellow(`No elements matched selector: ${selector}`));
    process.exit(2);
  }

  for (const [i, r] of results.entries()) {
    if (i > 0) console.log('---');
    console.log(r);
  }
}

export interface BrowserScreenshotOptions {
  url: string;
  path: string;
  fullPage?: boolean;
}

/**
 * `goldfish browser screenshot <url> <path>` — visual debugging aid.
 */
export async function browserScreenshot({
  url,
  path: outPath,
  fullPage = true,
}: BrowserScreenshotOptions): Promise<void> {
  const absPath = path.resolve(outPath);
  await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: absPath, fullPage });
  });
  console.log(chalk.green(`✓ Screenshot saved: ${absPath}`));
}
