import chalk from 'chalk';
import { createSlackClientFromEnv } from '../adapters/SlackBoltClient.js';
import { createChildLogger } from '../lib/logger.js';
import { resolveDestination, describeDestination } from '../lib/slackDestination.js';

const logger = createChildLogger('cli:send');

export interface SendOptions {
  channel?: string;
  thread?: string;
  /** Post at channel top level, ignoring the thread inherited from the session. */
  noThread?: boolean;
  message: string;
  dryRun?: boolean;
}

/**
 * Send a message to Slack
 */
export async function send(options: SendOptions): Promise<void> {
  const { channel, thread, noThread, message, dryRun } = options;

  // Previously this fell back to `thread.split('.')[0]` when no channel was
  // given, on the theory that a thread ts "might contain" a channel. It does
  // not — `1789695896.665579` yields `1789695896`, which is not a channel id.
  // Resolution now goes flag → session environment → loud error.
  const destResult = resolveDestination({ channel, thread, noThread });
  if (!destResult.ok) {
    console.log(chalk.red(`Error: ${destResult.error}`));
    process.exit(1);
  }
  const dest = destResult.value;

  if (dryRun) {
    console.log(chalk.yellow('\n[DRY RUN] Would send:\n'));
    console.log(`  To:      ${describeDestination(dest)}`);
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
  console.log(chalk.dim(`Sending to ${describeDestination(dest)}...`));

  const sendResult = await client.sendMessage({
    channel: dest.channel,
    text: message,
    threadTs: dest.threadTs,
  });

  if (!sendResult.ok) {
    console.log(chalk.red(`Error: ${sendResult.error.message}`));
    process.exit(1);
  }

  console.log(
    chalk.green(`✓ Message sent to ${describeDestination(dest)} (ts: ${sendResult.value})`),
  );
  logger.info(
    {
      channel: dest.channel,
      thread: dest.threadTs,
      channelInherited: dest.channelInherited,
      threadInherited: dest.threadInherited,
      ts: sendResult.value,
    },
    'Message sent',
  );
}
