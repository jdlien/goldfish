#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import {
  authStatus,
  authTest,
  send,
  upload,
  start,
  initiate,
  init,
  scheduleRun,
  scheduleList,
  browserLogin,
  browserGoto,
  browserScrape,
  browserScreenshot,
} from './cli/index.js';

const program = new Command();

program
  .name('goldfish')
  .description('AI agent runtime — Claude Code-native Slack bot with persistent memory')
  .version('0.1.0');

// Auth commands
const auth = program.command('auth').description('Authentication management');

auth
  .command('status')
  .description('Show auth configuration status')
  .action(authStatus);

auth
  .command('test')
  .description('Test Slack API connection')
  .action(authTest);

// Init command
program
  .command('init [path]')
  .description('Create a new agent workspace')
  .action(async (path?: string) => {
    await init({ path });
  });

// Start command
program
  .command('start')
  .description('Start the Goldfish bot (Socket Mode)')
  .action(start);

// Send command
program
  .command('send')
  .description('Send a message to Slack')
  .requiredOption('-m, --message <text>', 'Message to send')
  .option('-c, --channel <id>', 'Channel ID to send to')
  .option('-t, --thread <ts>', 'Thread timestamp to reply to')
  .option('--dry-run', 'Show what would be sent without sending')
  .action((options) => {
    send({
      channel: options.channel,
      thread: options.thread,
      message: options.message,
      dryRun: options.dryRun,
    });
  });

// Upload command
program
  .command('upload')
  .description('Upload a file to Slack')
  .requiredOption('-f, --file <path>', 'Path to file to upload')
  .option('-c, --channel <id>', 'Channel ID to share the file to')
  .option('-t, --thread <ts>', 'Thread timestamp to share the file in')
  .option('--title <title>', 'Title for the file')
  .option('--comment <text>', 'Initial comment to accompany the file')
  .option('--dry-run', 'Show what would be uploaded without uploading')
  .action((options) => {
    upload({
      file: options.file,
      channel: options.channel,
      thread: options.thread,
      title: options.title,
      comment: options.comment,
      dryRun: options.dryRun,
    });
  });

// Initiate command (proactive outreach)
program
  .command('initiate')
  .description('Initiate a proactive check-in via Slack DM')
  .requiredOption('-t, --type <type>', 'Check-in type: morning, weekly, exploration, or heartbeat')
  .option('-c, --channel <id>', 'Channel ID (defaults to GOLDFISH_DM_CHANNEL_ID)')
  .option('--context <text>', 'Additional context/focus for this session')
  .option('--reminder <text>', 'Reminder message (instead of full briefing)')
  .option('--dry-run', 'Show what would be sent without sending')
  .action((options) => {
    if (!['morning', 'weekly', 'exploration', 'heartbeat'].includes(options.type)) {
      console.error('Error: --type must be "morning", "weekly", "exploration", or "heartbeat"');
      process.exit(1);
    }
    initiate({
      type: options.type as 'morning' | 'weekly' | 'exploration' | 'heartbeat',
      channel: options.channel,
      context: options.context,
      reminder: options.reminder,
      dryRun: options.dryRun,
    });
  });

// Index memory command
program
  .command('index-memory')
  .description('Rebuild the FTS5 memory search index')
  .option('-w, --workspace <path>', 'Workspace path (defaults to GOLDFISH_WORKSPACE)')
  .option('-d, --db <path>', 'Database path (defaults to <workspace>/memory/search.sqlite)')
  .action(async (options) => {
    const { indexWorkspace } = await import('./lib/memoryIndexer.js');
    const { WORKSPACE_PATH, SEARCH_DB_PATH } = await import('./config.js');

    const workspace = options.workspace || WORKSPACE_PATH;
    const dbPath = options.db || SEARCH_DB_PATH;

    console.log(`Indexing ${workspace} → ${dbPath}`);
    const stats = indexWorkspace(dbPath, workspace);
    console.log(
      `Index complete: ${stats.indexed} indexed, ${stats.skipped} unchanged, ` +
      `${stats.removed} removed, ${stats.totalChunks} new chunks`
    );
  });

// Schedule commands
const schedule = program.command('schedule').description('Manage scheduled tasks');

schedule
  .command('run')
  .description('Run any scheduled tasks due this minute')
  .option('--config <path>', 'Path to schedule.yaml')
  .option('--dry-run', 'Show what would run without executing')
  .action((options) => {
    scheduleRun({
      config: options.config,
      dryRun: options.dryRun,
    });
  });

schedule
  .command('list')
  .description('List all configured scheduled tasks')
  .option('--config <path>', 'Path to schedule.yaml')
  .action((options) => {
    scheduleList({
      config: options.config,
    });
  });

// Browser commands
const browser = program
  .command('browser')
  .description('Stealth browser automation (patchright + persistent profile)');

browser
  .command('login')
  .description('Launch headful browser so you can log into sites manually')
  .action(async () => {
    try {
      await browserLogin();
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  });

browser
  .command('goto <url>')
  .description('Navigate to a URL and print the rendered page')
  .option('--html', 'Output raw HTML instead of rendered text')
  .option('--wait', 'Wait for full network idle (only for sites without long-polling)')
  .action(async (url: string, options: { html?: boolean; wait?: boolean }) => {
    try {
      await browserGoto({
        url,
        format: options.html ? 'html' : 'text',
        waitNetworkIdle: options.wait === true,
      });
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  });

browser
  .command('scrape <url> <selector>')
  .description('Navigate to URL and print elements matching a CSS selector')
  .option('--html', 'Return outerHTML of each match instead of innerText')
  .action(async (url: string, selector: string, options: { html?: boolean }) => {
    try {
      await browserScrape({ url, selector, attr: options.html ? 'html' : 'text' });
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  });

browser
  .command('screenshot <url> <path>')
  .description('Save a screenshot of a URL to a file')
  .option('--viewport-only', 'Capture only the viewport instead of the full page')
  .action(async (url: string, outPath: string, options: { viewportOnly?: boolean }) => {
    try {
      await browserScreenshot({ url, path: outPath, fullPage: !options.viewportOnly });
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  });

program.parse();
