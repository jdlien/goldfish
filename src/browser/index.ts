import { chromium, type BrowserContext } from 'patchright';
import lockfile from 'proper-lockfile';
import { USER_DATA_DIR } from './constants.js';

export { USER_DATA_DIR };

export interface WithBrowserOptions {
  /** Launch headful (visible) instead of headless. Required for first-run logins. */
  headless?: boolean;
}

/**
 * Run `fn` against a stealth-patched Chromium backed by Goldfish's persistent profile.
 *
 * - Uses patchright (Playwright fork with anti-detection patches baked in).
 * - Shares one userDataDir across runs so cookies/logins persist.
 * - Serializes concurrent callers via a lockfile on the userDataDir — the second
 *   caller waits instead of crashing on Chromium's own profile lock.
 */
export async function withBrowser<T>(
  fn: (ctx: BrowserContext) => Promise<T>,
  { headless = true }: WithBrowserOptions = {}
): Promise<T> {
  const release = await lockfile.lock(USER_DATA_DIR, {
    retries: { retries: 30, minTimeout: 500, maxTimeout: 2000 },
    stale: 60_000,
  });
  try {
    const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless,
      channel: 'chrome',
      viewport: { width: 1280, height: 800 },
    });
    try {
      return await fn(ctx);
    } finally {
      await ctx.close();
    }
  } finally {
    await release();
  }
}
