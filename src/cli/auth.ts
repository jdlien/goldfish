import chalk from 'chalk';
import { createSlackClientFromEnv } from '../adapters/SlackBoltClient.js';
import { ClaudeRunner } from '../adapters/ClaudeRunner.js';
import { createChildLogger } from '../lib/logger.js';

const logger = createChildLogger('cli:auth');

/**
 * Show auth status (check if tokens are configured)
 */
export async function authStatus(): Promise<void> {
  console.log(chalk.bold('\nSlack Bot Auth Status\n'));

  // Check environment variables
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;

  console.log('Environment Variables:');
  console.log(
    `  SLACK_APP_TOKEN: ${appToken ? chalk.green('✓ Set') : chalk.red('✗ Not set')}`
  );
  console.log(
    `  SLACK_BOT_TOKEN: ${botToken ? chalk.green('✓ Set') : chalk.red('✗ Not set')}`
  );

  if (appToken) {
    const prefix = appToken.substring(0, 10);
    console.log(`    Prefix: ${prefix}...`);
  }

  if (botToken) {
    const prefix = botToken.substring(0, 10);
    console.log(`    Prefix: ${prefix}...`);
  }

  // Check Claude CLI
  console.log('\nClaude CLI:');
  const claudeRunner = new ClaudeRunner();
  const claudeResult = await claudeRunner.checkAvailable();

  if (claudeResult.ok) {
    console.log(`  ${chalk.green('✓')} Available: ${claudeResult.value}`);
  } else {
    console.log(`  ${chalk.red('✗')} Not available: ${claudeResult.error.message}`);
  }

  console.log('');
}

/**
 * Test Slack API connection
 */
export async function authTest(): Promise<void> {
  console.log(chalk.bold('\nTesting Slack Connection...\n'));

  // Create client
  const clientResult = createSlackClientFromEnv();
  if (!clientResult.ok) {
    console.log(chalk.red(`✗ ${clientResult.error.message}`));
    process.exit(1);
  }

  const client = clientResult.value;

  // Initialize
  const initResult = await client.initialize();
  if (!initResult.ok) {
    console.log(chalk.red(`✗ Failed to initialize: ${initResult.error.message}`));
    process.exit(1);
  }

  // Test connection
  const testResult = await client.testConnection();
  if (!testResult.ok) {
    console.log(chalk.red(`✗ Connection test failed: ${testResult.error.message}`));
    process.exit(1);
  }

  const { teamName, botName, botUserId } = testResult.value;

  console.log(chalk.green('✓ Connected successfully!\n'));
  console.log(`  Workspace: ${chalk.bold(teamName)}`);
  console.log(`  Bot Name:  ${chalk.bold(botName)}`);
  console.log(`  Bot ID:    ${chalk.bold(botUserId)}`);

  // Test Claude
  console.log('\nTesting Claude CLI...');
  const claudeRunner = new ClaudeRunner();
  const claudeResult = await claudeRunner.checkAvailable();

  if (claudeResult.ok) {
    console.log(chalk.green(`✓ Claude CLI available: ${claudeResult.value}`));
  } else {
    console.log(chalk.yellow(`⚠ Claude CLI issue: ${claudeResult.error.message}`));
  }

  console.log('');
  logger.info({ teamName, botName, botUserId }, 'Auth test completed');
}
