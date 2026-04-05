import chalk from 'chalk';
import { createSlackClientFromEnv } from '../adapters/SlackBoltClient.js';
import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('cli:send');

export interface SendOptions {
  channel?: string;
  thread?: string;
  message: string;
  dryRun?: boolean;
}

/**
 * Send a message to Slack
 */
export async function send(options: SendOptions): Promise<void> {
  const { channel, thread, message, dryRun } = options;

  if (!channel && !thread) {
    console.log(chalk.red('Error: Either --channel or --thread is required'));
    process.exit(1);
  }

  const targetChannel = channel ?? thread!.split('.')[0]; // Thread ts might contain channel

  if (dryRun) {
    console.log(chalk.yellow('\n[DRY RUN] Would send:\n'));
    console.log(`  Channel: ${targetChannel}`);
    if (thread) {
      console.log(`  Thread:  ${thread}`);
    }
    console.log(`  Message: ${message}`);
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

  // Send message
  console.log(chalk.dim('Sending message...'));

  const sendResult = await client.sendMessage({
    channel: targetChannel,
    text: message,
    threadTs: thread,
  });

  if (!sendResult.ok) {
    console.log(chalk.red(`Error: ${sendResult.error.message}`));
    process.exit(1);
  }

  console.log(chalk.green(`✓ Message sent (ts: ${sendResult.value})`));
  logger.info({ channel: targetChannel, thread, ts: sendResult.value }, 'Message sent');
}
