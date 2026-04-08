/**
 * Initiate Command
 * Starts a proactive check-in via Slack DM (morning briefing, weekly review, etc.)
 */

import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createSlackClientFromEnv } from '../adapters/SlackBoltClient.js';
import { ClaudeRunner } from '../adapters/ClaudeRunner.js';
import { SqliteRepo } from '../adapters/SqliteRepo.js';
import { initDb, closeDb } from '../db/index.js';
import { createChildLogger } from '../lib/logger.js';
import { formatForSlack, splitSlackMessage } from '../lib/slackFormatter.js';
import { WORKSPACE_PATH, validateWorkspace } from '../config.js';

const logger = createChildLogger('cli:initiate');

export interface InitiateOptions {
  type: 'morning' | 'weekly' | 'exploration' | 'heartbeat';
  channel?: string;
  context?: string;
  reminder?: string;
  dryRun?: boolean;
  model?: string;
}

/**
 * Read a prompt file from the workspace's prompts/ directory.
 * Returns the file contents with {{DATE}} replaced, or null if not found.
 */
function loadWorkspacePrompt(type: string): string | null {
  const promptPath = join(WORKSPACE_PATH, 'prompts', `${type}.md`);
  if (!existsSync(promptPath)) return null;
  const content = readFileSync(promptPath, 'utf-8');
  return content.replaceAll('{{DATE}}', new Date().toISOString().slice(0, 10));
}

/**
 * Build the proactive prompt. Loads from workspace prompts/ directory first,
 * falling back to built-in defaults if no custom prompt file exists.
 */
export function buildPrompt(options: InitiateOptions): string {
  const { type, context, reminder } = options;

  if (reminder) {
    return [
      'You are preparing a scheduled reminder for the user.',
      'Do NOT use any Slack tools to post messages — just write the reminder as your text response.',
      'Be brief and helpful. Deliver this reminder:',
      '',
      reminder,
      '',
      'Keep it to 2-3 sentences. Use Slack mrkdwn (*bold*, no tables, no headers).',
    ].join('\n');
  }

  // Try workspace prompt file first
  let prompt = loadWorkspacePrompt(type);

  // Fall back to built-in defaults
  if (!prompt) {
    prompt = getDefaultPrompt(type);
  }

  if (context) {
    prompt += `\n\n## Additional Context\n\n${context}`;
  }

  return prompt;
}

/** Built-in fallback prompts for when no workspace prompt file exists. */
function getDefaultPrompt(type: string): string {
  const today = new Date().toISOString().slice(0, 10);

  switch (type) {
    case 'heartbeat':
      return [
        'This is a quiet background heartbeat check.',
        'You are checking if anything needs the user\'s attention.',
        '',
        'IMPORTANT: Do NOT use any Slack tools to post messages. Do NOT call slack_send_message.',
        'Just write your response as text. The delivery system handles posting to Slack.',
        '',
        '## What to check',
        '',
        '1. Check your workspace CLAUDE.md for any configured tools (email, calendar, etc.) and run them',
        '2. Read FOCUS.md — are there deadlines approaching or items at risk?',
        `3. Read memory/${today}.md for today's context`,
        '',
        '## Response rules',
        '',
        'CRITICAL: If there is NOTHING actionable — no urgent emails, no imminent calendar events,',
        'no deadlines at risk — respond with EXACTLY the text "HEARTBEAT_OK" and nothing else.',
        'Do NOT say "all clear" or "nothing to report." Just "HEARTBEAT_OK".',
        '',
        'ONLY send a real message if something genuinely needs attention:',
        '- VIP email that needs a response',
        '- Calendar event starting within 2 hours',
        '- FOCUS.md deadline at risk with no visible progress',
        '- Something time-sensitive from yesterday\'s context',
        '',
        'If you DO have something to say, be brief — 2-4 lines max.',
        'Use Slack mrkdwn. No headers, no emoji spam. Just the actionable info.',
        'Tone: a friend tapping you on the shoulder, not a project manager.',
      ].join('\n');

    case 'exploration':
      return [
        'This is your evening self-study session.',
        '',
        'IMPORTANT: Do NOT use any Slack tools to post messages. Do NOT call slack_send_message.',
        'Your text response will be posted to Slack by the delivery system.',
        '',
        '## What to do',
        '',
        '1. Read IDENTITY.md to remember who you are and what interests you',
        '2. Read memory/explorations/TOPICS.md for past explorations',
        '   - Topics marked with ~~strikethrough~~ ✅ DONE have already been explored — do NOT pick these',
        '   - Pick from unmarked topics in the Queue section, or choose something entirely new',
        '3. Go deep. Use WebSearch if you need to research. Read relevant files if the topic connects to something in memory.',
        '4. Write the full exploration (800-2000 words) and save it to a file',
        '5. Update TOPICS.md to mark the topic as done and add a completed entry',
        '',
        '## File output',
        '',
        `Save the full exploration to memory/explorations/${today}-<topic-slug>.md`,
        'Mark the topic as ~~strikethrough~~ ✅ DONE in the Queue section of TOPICS.md.',
        'Add a one-line completed entry in the Completed section.',
        '',
        '## Slack summary (your text response)',
        '',
        'Your text response is what gets posted to Slack. Keep it SHORT — a brief announcement, not the full piece.',
        'Use Slack mrkdwn (*bold*, _italic_, no tables, no # headers).',
        '',
        'Format:',
        '🔭 *Topic Title*',
        '',
        '2-3 sentence hook — the most interesting insight or question from the exploration.',
        '',
        '_Full exploration saved to `memory/explorations/<filename>.md`_',
      ].join('\n');

    default: {
      // morning and weekly
      const sessionType = type === 'morning' ? 'Morning Check-in' : 'Weekly Review';
      return [
        `You are preparing a proactive ${sessionType}.`,
        'Write the check-in as your text response — the delivery system will post it to Slack.',
        '',
        'IMPORTANT: Do NOT use any Slack tools to post messages. Do NOT call slack_send_message.',
        'The user has not said anything yet — you are initiating.',
        '',
        '## What to do',
        '',
        '1. Read FOCUS.md for current priorities',
        `2. Read memory/${today}.md (or yesterday) for recent context`,
        '3. Check your workspace CLAUDE.md for any configured tools (email, calendar, etc.) and run them',
        '',
        '## Output Format',
        '',
        'Use Slack mrkdwn: *bold* (single asterisks), bullet lists, no tables, no # headers.',
        '',
        'Structure:',
        '- *Quick Summary:* 2-3 key points about today/this week',
        '- *Suggested Focus:* What to tackle first',
        '- End with an engaging question to start dialogue',
      ].join('\n');
    }
  }
}

/**
 * Initiate a proactive check-in
 */
export async function initiate(options: InitiateOptions): Promise<void> {
  const { type, dryRun } = options;

  const channel = options.channel || process.env.GOLDFISH_DM_CHANNEL_ID;
  if (!channel) {
    console.log(chalk.red('Error: No channel specified.'));
    console.log(chalk.dim('Set GOLDFISH_DM_CHANNEL_ID in .env or use --channel'));
    process.exit(1);
  }

  const prompt = buildPrompt(options);

  if (dryRun) {
    console.log(chalk.yellow('\n--- DRY RUN ---\n'));
    console.log(chalk.bold('Channel:'), channel);
    console.log(chalk.bold('Type:'), type);
    console.log(chalk.bold('\nPrompt Preview:\n'));
    console.log(chalk.dim(prompt.substring(0, 2000)));
    console.log(chalk.yellow('\n--- END DRY RUN ---\n'));
    return;
  }

  console.log(chalk.bold(`\n🐟 Initiating ${type} check-in...\n`));

  // Validate workspace before doing anything else
  const workspaceError = validateWorkspace();
  if (workspaceError) {
    console.log(chalk.red(workspaceError));
    process.exit(1);
  }

  const db = await initDb();
  const repo = new SqliteRepo(db);

  const clientResult = createSlackClientFromEnv();
  if (!clientResult.ok) {
    console.log(chalk.red(`Error: ${clientResult.error.message}`));
    await closeDb();
    process.exit(1);
  }

  const slackClient = clientResult.value;
  const initResult = await slackClient.initialize();
  if (!initResult.ok) {
    console.log(chalk.red(`Error: ${initResult.error.message}`));
    await closeDb();
    process.exit(1);
  }

  const claudeRunner = new ClaudeRunner();

  try {
    // Send preparing message (skip for heartbeat — it may stay silent)
    let messageTs: string | null = null;
    if (type !== 'heartbeat') {
      console.log(chalk.dim('Sending initial message...'));
      const preparingResult = await slackClient.sendMessage({
        channel,
        text: '🐟 Preparing your check-in...',
      });
      messageTs = preparingResult.ok ? preparingResult.value : null;
    }

    // Run Claude
    console.log(chalk.dim('Running Claude...'));
    const claudeResult = await claudeRunner.run({
      prompt,
      maxTurns: 15,
      model: options.model,
    });

    if (!claudeResult.ok) {
      logger.error({ error: claudeResult.error }, 'Claude invocation failed');
      if (messageTs) {
        await slackClient.updateMessage({
          channel,
          ts: messageTs,
          text: `❌ Error: ${claudeResult.error.message}`,
        });
      }
      await closeDb();
      process.exit(1);
    }

    const { result, sessionId: claudeSessionId, durationMs } = claudeResult.value;

    // Heartbeat: if nothing actionable, stay silent
    if (type === 'heartbeat' && result.trim().startsWith('HEARTBEAT_OK')) {
      console.log(chalk.dim('Heartbeat: nothing actionable. Staying silent.'));
      logger.info({ claudeSessionId, durationMs }, 'Heartbeat OK — no message sent');
      // Clean up the preparing message if we sent one
      if (messageTs) {
        await slackClient.deleteMessage({ channel, ts: messageTs }).catch(() => {});
      }
      await closeDb();
      return;
    }

    const formattedResult = formatForSlack(result);
    const chunks = splitSlackMessage(formattedResult);

    // Update or send the response (first chunk replaces "Preparing..." message)
    let finalMessageTs: string;
    if (messageTs) {
      const updateResult = await slackClient.updateMessage({ channel, ts: messageTs, text: chunks[0] });
      if (!updateResult.ok) {
        // If update fails (e.g. msg_too_long), try sending as new message instead
        logger.warn({ error: updateResult.error }, 'Failed to update message, sending as new');
        const sendResult = await slackClient.sendMessage({ channel, text: chunks[0] });
        finalMessageTs = sendResult.ok ? sendResult.value : messageTs;
        // Clean up the stuck "Preparing..." message
        await slackClient.deleteMessage({ channel, ts: messageTs }).catch(() => {});
      } else {
        finalMessageTs = messageTs;
      }
    } else {
      const sendResult = await slackClient.sendMessage({ channel, text: chunks[0] });
      finalMessageTs = sendResult.ok ? sendResult.value : '';
    }

    // Send remaining chunks as thread replies
    for (let i = 1; i < chunks.length; i++) {
      await slackClient.sendMessage({ channel, text: chunks[i], threadTs: finalMessageTs });
    }

    // Create session so thread replies continue this conversation
    if (finalMessageTs) {
      const sessionResult = await repo.getOrCreateSession(channel, finalMessageTs);
      if (sessionResult.ok && claudeSessionId) {
        await repo.updateClaudeSessionId(sessionResult.value.id, claudeSessionId);
        await repo.saveMessage({
          sessionId: sessionResult.value.id,
          slackTs: finalMessageTs,
          direction: 'outbound',
          content: result,
        });
      }
    }

    console.log(chalk.green('\n✓ Check-in sent!\n'));
    console.log(`  Claude Session: ${claudeSessionId}`);
    console.log(`  Duration: ${durationMs}ms`);
    console.log(chalk.dim('\nReplies in this thread will continue the session.'));

    logger.info({ claudeSessionId, durationMs }, 'Proactive check-in completed');
  } finally {
    await closeDb();
  }
}
