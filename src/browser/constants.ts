import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Persistent Chromium profile used by Goldfish's browser tool.
 *
 * All runs share one profile so cookies and logins survive across invocations.
 * Only one process may use this directory at a time — callers must go through
 * `withBrowser`, which serializes access via a lockfile.
 */
export const USER_DATA_DIR = path.join(
  homedir(),
  'Library/Application Support/goldfish/browser-profile'
);
