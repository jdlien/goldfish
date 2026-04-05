import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { createSlackClientFromEnv } from '../adapters/SlackBoltClient.js';
import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('cli:upload');

export interface UploadOptions {
  file: string;
  channel?: string;
  thread?: string;
  title?: string;
  comment?: string;
  dryRun?: boolean;
}

/**
 * Upload a file to Slack
 */
export async function upload(options: UploadOptions): Promise<void> {
  const { file, channel, thread, title, comment, dryRun } = options;

  // Resolve file path
  const filePath = path.resolve(file);

  // Check file exists
  if (!fs.existsSync(filePath)) {
    console.log(chalk.red(`Error: File not found: ${filePath}`));
    process.exit(1);
  }

  // Get file stats
  const stats = fs.statSync(filePath);
  const filename = path.basename(filePath);
  const sizeKB = (stats.size / 1024).toFixed(1);

  if (dryRun) {
    console.log(chalk.yellow('\n[DRY RUN] Would upload:\n'));
    console.log(`  File:     ${filePath}`);
    console.log(`  Filename: ${filename}`);
    console.log(`  Size:     ${sizeKB} KB`);
    if (channel) {
      console.log(`  Channel:  ${channel}`);
    }
    if (thread) {
      console.log(`  Thread:   ${thread}`);
    }
    if (title) {
      console.log(`  Title:    ${title}`);
    }
    if (comment) {
      console.log(`  Comment:  ${comment}`);
    }
    console.log('');
    return;
  }

  // Create and initialize client
  const clientResult = createSlackClientFromEnv();
  if (!clientResult.ok) {
    console.log(chalk.red(`Error: ${clientResult.error.message}`));
    process.exit(1);
  }

  const client = clientResult.value;

  const initResult = await client.initialize();
  if (!initResult.ok) {
    console.log(chalk.red(`Error: ${initResult.error.message}`));
    process.exit(1);
  }

  // Read file content
  console.log(chalk.dim(`Reading ${filename} (${sizeKB} KB)...`));
  const content = fs.readFileSync(filePath);

  // Upload file
  console.log(chalk.dim('Uploading to Slack...'));

  const uploadResult = await client.uploadFile({
    content,
    filename,
    channel,
    threadTs: thread,
    title,
    initialComment: comment,
  });

  if (!uploadResult.ok) {
    console.log(chalk.red(`Error: ${uploadResult.error.message}`));
    if (uploadResult.error.cause) {
      console.log(chalk.dim(`Cause: ${String(uploadResult.error.cause)}`));
    }
    process.exit(1);
  }

  const result = uploadResult.value;
  console.log(chalk.green(`\n✓ File uploaded successfully`));
  console.log(`  File ID:   ${result.fileId}`);
  if (result.permalink) {
    console.log(`  Permalink: ${result.permalink}`);
  }

  logger.info(
    {
      fileId: result.fileId,
      filename,
      channel,
      thread,
      permalink: result.permalink,
    },
    'File uploaded'
  );
}
