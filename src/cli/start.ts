import chalk from 'chalk';
import { createSlackClientFromEnv, type SlackBoltClient } from '../adapters/SlackBoltClient.js';
import { ClaudeRunner } from '../adapters/ClaudeRunner.js';
import { SqliteRepo } from '../adapters/SqliteRepo.js';
import { writeTranscript } from '../adapters/TranscriptWriter.js';
import { initDb, closeDb } from '../db/index.js';
import { createChildLogger } from '../lib/logger.js';
import { formatForSlack, splitSlackMessage } from '../lib/slackFormatter.js';
import { SlackStreamUpdater } from '../lib/SlackStreamUpdater.js';
import { SlackNativeStreamer } from '../lib/SlackNativeStreamer.js';
import { extractToolSources } from '../lib/toolSources.js';
import { SlackFileDownloader, type SlackFile } from '../adapters/SlackFileDownloader.js';
import { ErrorCodes } from '../domain/services/result.js';
import {
  SESSION_EXPIRY_MS,
  STREAMING_ENABLED,
  NATIVE_STREAMING_ENABLED,
  MAX_ATTACHMENTS_PER_MESSAGE,
  SHOW_TOOLS,
  validateWorkspace,
} from '../config.js';

interface SlackDmMessage {
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  subtype?: string;
  user?: string;
  files?: SlackFile[];
}

const logger = createChildLogger('cli:start');

let isShuttingDown = false;
let slackClient: SlackBoltClient | null = null;

// Per-session concurrency lock: serializes Claude invocations so two messages
// in the same thread don't spawn competing processes on the same session.
const sessionLocks = new Map<string, Promise<void>>();

/**
 * Start the Goldfish bot
 */
export async function start(): Promise<void> {
  console.log(chalk.bold('\n🐟 Starting Goldfish...\n'));

  // Validate workspace before doing anything else
  const workspaceError = validateWorkspace();
  if (workspaceError) {
    console.log(chalk.red(workspaceError));
    process.exit(1);
  }

  // Initialize database
  console.log(chalk.dim('Initializing database...'));
  const db = await initDb();
  const repo = new SqliteRepo(db);
  logger.info('Database initialized');

  // Create Slack client
  const clientResult = createSlackClientFromEnv();
  if (!clientResult.ok) {
    console.log(chalk.red(`Error: ${clientResult.error.message}`));
    process.exit(1);
  }

  slackClient = clientResult.value;

  // Initialize Slack app
  const initResult = await slackClient.initialize();
  if (!initResult.ok) {
    console.log(chalk.red(`Error: ${initResult.error.message}`));
    process.exit(1);
  }

  // Create Claude runner
  const claudeRunner = new ClaudeRunner();

  // Create file downloader (for Slack image/attachment handling)
  const slackBotToken = process.env.SLACK_BOT_TOKEN ?? '';
  const fileDownloader = new SlackFileDownloader(slackBotToken);

  // Verify Claude is available
  const claudeCheck = await claudeRunner.checkAvailable();
  if (!claudeCheck.ok) {
    console.log(chalk.yellow(`⚠ Warning: ${claudeCheck.error.message}`));
    console.log(chalk.yellow('  Bot will respond with errors until Claude is available.'));
  }

  const app = slackClient.getApp();

  // Get the bot's own user ID so we can ignore our own messages
  const authInfo = await slackClient.testConnection();
  const botUserId = authInfo.ok ? authInfo.value.botUserId : null;
  const teamId = authInfo.ok ? authInfo.value.teamId : '';
  if (botUserId) {
    logger.info({ botUserId, teamId }, 'Bot user ID resolved');
  } else {
    logger.warn('Could not resolve bot user ID — self-message filtering disabled');
  }

  // Channels the bot listens on (in addition to DMs)
  const listenChannels = (process.env.GOLDFISH_CHANNELS ?? '').split(',').filter(Boolean);

  // Handle messages
  app.message(async ({ message, say }) => {
    const isDirectMessage = message.channel_type === 'im';
    const isListenChannel = listenChannels.includes(message.channel);

    if (!isDirectMessage && !isListenChannel) {
      return;
    }

    const msg = message as SlackDmMessage;
    const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
    // Need either text or file attachments
    if (!msg.text && !hasFiles) return;
    // Drop unknown subtypes, but not file_share (that's how Slack delivers attachments)
    if (msg.subtype && msg.subtype !== 'file_share') return;
    if (msg.user === undefined || msg.user === '') return;

    // Don't respond to our own messages (prevents loops in channels)
    if (botUserId && msg.user === botUserId) return;

    const channelId = msg.channel;
    const sessionKey = msg.thread_ts ?? msg.ts;
    const replyThreadTs = isListenChannel
      ? (msg.thread_ts ?? msg.ts)
      : msg.thread_ts;
    let userMessage = msg.text ?? '';

    logger.info(
      {
        channelId,
        sessionKey,
        replyThreadTs,
        messageTs: msg.ts,
        textLength: userMessage.length,
        fileCount: msg.files?.length ?? 0,
      },
      'Received message',
    );

    // --- Per-session concurrency lock ---
    // If a Claude process is already running for this thread, queue the
    // new message behind it so they don't fight over the same session.
    const lockKey = `${channelId}:${sessionKey}`;
    const isQueued = sessionLocks.has(lockKey);

    // Show "Queued..." if another message is already being processed,
    // otherwise show the normal "is thinking..." indicator.
    const statusThreadTs = msg.thread_ts ?? msg.ts;
    let queuedMsgTs: string | null = null;
    if (isQueued) {
      logger.info({ lockKey }, 'Session busy — queuing message');
      const queuedResult = await slackClient!.sendMessage({
        channel: channelId,
        text: '⏳ Queued...',
        threadTs: replyThreadTs,
      }).catch((error) => {
        logger.debug({ error }, 'Failed to post queued indicator (non-fatal)');
        return null;
      });
      if (queuedResult && queuedResult.ok) {
        queuedMsgTs = queuedResult.value;
      }
    } else {
      // Show a native "is thinking..." indicator immediately — this fires
      // before session lookup, file downloads, or Claude spawn, so the user
      // gets instant feedback. Slack auto-clears it when the stream starts.
      // Fire-and-forget: if the app isn't configured for assistant threads,
      // this degrades silently without blocking the main flow.
      void slackClient!.getWebClient().assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: statusThreadTs,
        status: 'is thinking...',
      }).catch((error) => {
        logger.debug({ error }, 'assistant.threads.setStatus failed (non-fatal)');
      });
    }

    const previousWork = sessionLocks.get(lockKey) ?? Promise.resolve();

    const currentWork = previousWork.then(async () => {
      // Delete the "Queued..." message and re-show "is thinking..." now that it's our turn
      if (isQueued) {
        if (queuedMsgTs) {
          await slackClient!.deleteMessage({ channel: channelId, ts: queuedMsgTs }).catch(() => {});
        }
        void slackClient!.getWebClient().assistant.threads.setStatus({
          channel_id: channelId,
          thread_ts: statusThreadTs,
          status: 'is thinking...',
        }).catch(() => {});
      }

    try {
      // Get or create session
      const sessionResult = await repo.getOrCreateSession(channelId, sessionKey);
      if (!sessionResult.ok) {
        logger.error({ error: sessionResult.error }, 'Failed to get/create session');
        await say({ text: '❌ Internal error: Could not create session.', thread_ts: replyThreadTs });
        return;
      }

      const session = sessionResult.value;

      // Check session expiry — if too old, start fresh (don't resume stale context)
      let resumeSessionId = session.claudeSessionId;
      const sessionAge = Date.now() - session.lastActiveAt;
      if (resumeSessionId && sessionAge > SESSION_EXPIRY_MS) {
        logger.info(
          { sessionId: session.id, ageMs: sessionAge },
          'Session expired, starting fresh',
        );
        resumeSessionId = null;
      }

      // Download any file attachments (images, PDFs, text, code, etc.)
      // and fold them into the prompt as [Attached file: <path>] markers.
      // The agent's personality (from workspace CLAUDE.md / IDENTITY.md)
      // handles the response naturally — no instructional prose injected.
      if (hasFiles) {
        const filesToProcess = msg.files!.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
        const attachmentPaths: string[] = [];
        const skipped: string[] = [];
        let scopeMissing = false;

        for (const file of filesToProcess) {
          const downloadResult = await fileDownloader.download(file);
          if (downloadResult.ok) {
            attachmentPaths.push(downloadResult.value.path);
          } else {
            const errorCode = downloadResult.error.code;
            const displayName = file.name ?? 'file';
            if (errorCode === ErrorCodes.SLACK_FILE_SCOPE_MISSING) {
              scopeMissing = true;
              skipped.push(`${displayName} (scope missing)`);
            } else if (errorCode === ErrorCodes.SLACK_FILE_TOO_LARGE) {
              skipped.push(`${displayName} (too large)`);
            } else if (errorCode === ErrorCodes.SLACK_FILE_UNSUPPORTED_TYPE) {
              skipped.push(`${displayName} (unsupported type)`);
            } else if (errorCode === ErrorCodes.HEIC_CONVERSION_FAILED) {
              skipped.push(`${displayName} (HEIC conversion failed)`);
            } else {
              skipped.push(displayName);
            }
            logger.warn(
              { error: downloadResult.error, fileId: file.id },
              'Failed to download Slack file',
            );
          }
        }

        // Scope missing is a special case — tell the user how to fix it
        if (scopeMissing && attachmentPaths.length === 0) {
          await say({
            text:
              '📎 I can see your attachment, but my Slack app is missing the `files:read` scope. ' +
              'Add it in the Goldfish app\'s OAuth settings and reinstall to enable attachment support.',
            thread_ts: replyThreadTs,
          });
          return;
        }

        // Append [Attached file: ...] marker(s) to the message
        if (attachmentPaths.length > 0) {
          const label = attachmentPaths.length === 1 ? 'Attached file' : 'Attached files';
          const paths = attachmentPaths.join(', ');
          userMessage = userMessage
            ? `${userMessage}\n\n[${label}: ${paths}]`
            : `[${label}: ${paths}]`;
        }

        // Note any files that couldn't be processed
        if (skipped.length > 0) {
          userMessage += `\n\n[Could not process: ${skipped.join(', ')}]`;
        }

        // If everything failed and there's no text, don't invoke Claude
        if (!userMessage.trim()) {
          await say({
            text: '📎 I got your file but couldn\'t process it — sorry. Try a different format or describe what you wanted to share.',
            thread_ts: replyThreadTs,
          });
          return;
        }

        logger.info(
          {
            attachmentCount: attachmentPaths.length,
            skippedCount: skipped.length,
          },
          'Processed message attachments',
        );
      }

      // Save inbound message
      await repo.saveMessage({
        sessionId: session.id,
        slackTs: msg.ts,
        direction: 'inbound',
        content: userMessage,
      });

      // Run Claude and send response
      logger.info(
        {
          sessionId: session.id,
          resumeSessionId,
          streaming: STREAMING_ENABLED,
          nativeStreaming: STREAMING_ENABLED && NATIVE_STREAMING_ENABLED,
        },
        'Invoking Claude',
      );

      if (STREAMING_ENABLED && NATIVE_STREAMING_ENABLED) {
        // Native streaming path: Slack's chat.startStream API renders
        // markdown server-side (tables, headers, bold, links, all native).
        // The SDK's ChatStreamer buffers internally — no throttling needed.
        // Streaming requires thread_ts, so even DMs are threaded.
        const streamThreadTs = msg.thread_ts ?? msg.ts;
        const nativeStreamer = new SlackNativeStreamer(
          slackClient!.getWebClient(),
          channelId,
          streamThreadTs,
          teamId || undefined,
          msg.user,
          SHOW_TOOLS,
        );

        let result = '';
        let claudeSessionId: string | undefined;
        let durationMs: number | undefined;
        let costUsd: number | undefined;

        try {
          nativeStreamer.start();

          const stream = claudeRunner.runStream({
            prompt: userMessage,
            resumeSessionId: resumeSessionId ?? undefined,
          });

          for await (const event of stream) {
            switch (event.type) {
              case 'text_delta':
                // Pass RAW markdown — Slack renders natively. appendText
                // also auto-completes any in-progress tools before sending.
                await nativeStreamer.appendText(event.text);
                break;
              case 'tool_start':
                // Send a task_update "in_progress" chunk — Slack renders
                // as a native timeline entry with a spinner.
                await nativeStreamer.startTool(event.toolId, event.toolName);
                break;
              case 'tool_end':
                // Intentionally no-op: tool_end fires when Claude finishes
                // generating the tool-call JSON, NOT when the tool finishes
                // executing. Completion comes via tool_result.
                break;
              case 'tool_result': {
                // Tool finished executing — mark complete with actual
                // stdout/stderr captured in the timeline entry. For web
                // tools, also attach source URLs so Slack renders them
                // as native clickable sources.
                const sources = extractToolSources(
                  event.toolName,
                  event.toolInput,
                  event.output,
                );
                await nativeStreamer.completeToolWithOutput(
                  event.toolId,
                  event.output,
                  event.isError,
                  sources,
                );
                break;
              }
              case 'result':
                result = event.result;
                claudeSessionId = event.sessionId;
                durationMs = event.durationMs;
                costUsd = event.costUsd;
                break;
            }
          }

          // If we didn't capture a result from the result event, use accumulated raw text
          if (!result) {
            result = nativeStreamer.getRawText();
          }

          // Close the stream. We've already streamed all deltas via append,
          // so no final text is needed here — finalize in place.
          await nativeStreamer.finish();
        } catch (error) {
          logger.error({ error }, 'Native streaming Claude invocation failed');
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          // Abort the stream with a short error marker. We can't pass the
          // full accumulated text because chat.stopStream({markdown_text})
          // APPENDS rather than replaces, which would duplicate everything.
          const accumulated = nativeStreamer.getRawText();
          const fallbackText = accumulated
            ? `_⚠️ Response interrupted: ${errorMessage}_`
            : `❌ Error: ${errorMessage}`;

          await nativeStreamer.abort(fallbackText);

          // If there's unsent text (the stream died mid-response), post
          // the remainder as a regular follow-up message so the user sees
          // the complete response instead of a truncated one.
          const unsent = nativeStreamer.getUnsentText();
          if (unsent.trim()) {
            logger.info(
              { unsentLength: unsent.length },
              'Posting unsent text as follow-up message after stream failure',
            );
            try {
              await slackClient!.getWebClient().chat.postMessage({
                channel: channelId,
                text: unsent,
                thread_ts: streamThreadTs,
              });
            } catch (postError) {
              logger.error(
                { error: postError },
                'Failed to post unsent text as follow-up',
              );
            }

            // Still save the full response to the transcript
            result = accumulated;
            if (claudeSessionId && claudeSessionId !== session.claudeSessionId) {
              await repo.updateClaudeSessionId(session.id, claudeSessionId);
            }
            await repo.saveMessage({
              sessionId: session.id,
              slackTs: streamThreadTs,
              direction: 'outbound',
              content: result,
            });
            writeTranscript({
              timestamp: new Date().toISOString(),
              slackChannel: channelId,
              slackThread: sessionKey,
              userMessage,
              assistantResponse: result,
              claudeSessionId: claudeSessionId ?? null,
              durationMs,
              costUsd,
            });
          }

          return;
        }

        // Update session with Claude session ID
        if (claudeSessionId && claudeSessionId !== session.claudeSessionId) {
          await repo.updateClaudeSessionId(session.id, claudeSessionId);
        }

        // Save outbound message — native streaming doesn't give us a ts
        // until after stop() resolves; for now use the user message ts as
        // a session key anchor. Transcript still captures full content.
        await repo.saveMessage({
          sessionId: session.id,
          slackTs: streamThreadTs,
          direction: 'outbound',
          content: result,
        });

        // Save transcript for memory pipeline
        writeTranscript({
          timestamp: new Date().toISOString(),
          slackChannel: channelId,
          slackThread: sessionKey,
          userMessage,
          assistantResponse: result,
          claudeSessionId: claudeSessionId ?? null,
          durationMs,
          costUsd,
        });

        logger.info(
          { sessionId: session.id, claudeSessionId, durationMs },
          'Native streaming response completed',
        );
      } else if (STREAMING_ENABLED) {
        // Streaming path: progressive Slack updates (lazy-posted on first content)
        const updater = new SlackStreamUpdater(slackClient!, channelId, replyThreadTs);
        await updater.start();
        // Note: start() no longer posts anything. The updater will lazy-post
        // the first message when real content (text or tool status) arrives.

        let result = '';
        let claudeSessionId: string | undefined;
        let durationMs: number | undefined;
        let costUsd: number | undefined;

        try {
          const stream = claudeRunner.runStream({
            prompt: userMessage,
            resumeSessionId: resumeSessionId ?? undefined,
          });

          for await (const event of stream) {
            switch (event.type) {
              case 'text_delta':
                // appendText clears tool status (new text phase starting)
                updater.appendText(event.text);
                break;
              case 'tool_start':
                updater.setToolStatus(event.toolName);
                // Force immediate update — don't wait for the next tick,
                // and don't let tool_end clear it before a tick runs
                await updater.tickNow();
                break;
              case 'tool_end':
                // Intentionally no-op: the tool_end event fires when Claude
                // finishes generating the tool-call JSON, NOT when the tool
                // finishes executing. We want the label visible during the
                // actual execution gap. It'll be cleared when text_delta
                // arrives or a new tool_start overrides it.
                break;
              case 'result':
                result = event.result;
                claudeSessionId = event.sessionId;
                durationMs = event.durationMs;
                costUsd = event.costUsd;
                break;
            }
          }

          // Use the result from the result event, or fall back to accumulated text
          if (!result) {
            result = updater.getRawText();
          }

          const formattedResult = formatForSlack(result);
          await updater.finish(formattedResult);
        } catch (error) {
          logger.error({ error }, 'Streaming Claude invocation failed');
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await updater.abort(`❌ Error: ${errorMessage}`);
          return;
        }

        // Update session with Claude session ID
        if (claudeSessionId && claudeSessionId !== session.claudeSessionId) {
          await repo.updateClaudeSessionId(session.id, claudeSessionId);
        }

        const responseTs = updater.getMessageTimestamps()[0] ?? '';

        // Save outbound message
        await repo.saveMessage({
          sessionId: session.id,
          slackTs: responseTs,
          direction: 'outbound',
          content: result,
        });

        // Save transcript for memory pipeline
        writeTranscript({
          timestamp: new Date().toISOString(),
          slackChannel: channelId,
          slackThread: sessionKey,
          userMessage,
          assistantResponse: result,
          claudeSessionId: claudeSessionId ?? null,
          durationMs,
          costUsd,
        });

        logger.info(
          { sessionId: session.id, claudeSessionId, durationMs },
          'Streaming response completed',
        );
      } else {
        // Non-streaming path: original block-and-post behavior
        const showThinking = process.env.GOLDFISH_SHOW_THINKING !== 'false';
        let thinkingTs: string | null = null;

        if (showThinking) {
          const thinkingResult = await slackClient!.sendMessage({
            channel: channelId,
            text: '⏳ Thinking...',
            threadTs: replyThreadTs,
          });
          thinkingTs = thinkingResult.ok ? thinkingResult.value : null;
        }

        const claudeResult = await claudeRunner.run({
          prompt: userMessage,
          resumeSessionId: resumeSessionId ?? undefined,
        });

        if (!claudeResult.ok) {
          logger.error({ error: claudeResult.error }, 'Claude invocation failed');
          if (thinkingTs) {
            await slackClient!.updateMessage({
              channel: channelId,
              ts: thinkingTs,
              text: `❌ Error: ${claudeResult.error.message}`,
            });
          } else {
            await say({ text: `❌ Error: ${claudeResult.error.message}`, thread_ts: replyThreadTs });
          }
          return;
        }

        const { result, sessionId: claudeSessionId, durationMs, costUsd } = claudeResult.value;
        const formattedResult = formatForSlack(result);

        if (claudeSessionId && claudeSessionId !== session.claudeSessionId) {
          await repo.updateClaudeSessionId(session.id, claudeSessionId);
        }

        if (thinkingTs) {
          await slackClient!.deleteMessage({ channel: channelId, ts: thinkingTs }).catch(() => {});
        }

        const chunks = splitSlackMessage(formattedResult);
        let responseTs = '';

        for (const chunk of chunks) {
          const sendResult = await slackClient!.sendMessage({
            channel: channelId,
            text: chunk,
            threadTs: replyThreadTs,
          });

          if (!sendResult.ok) {
            logger.error({ error: sendResult.error }, 'Failed to send response chunk');
            return;
          }

          if (!responseTs) responseTs = sendResult.value;
        }

        if (chunks.length > 1) {
          logger.info({ chunks: chunks.length }, 'Response split into multiple messages');
        }

        await repo.saveMessage({
          sessionId: session.id,
          slackTs: responseTs,
          direction: 'outbound',
          content: result,
        });

        writeTranscript({
          timestamp: new Date().toISOString(),
          slackChannel: channelId,
          slackThread: sessionKey,
          userMessage,
          assistantResponse: result,
          claudeSessionId: claudeSessionId ?? null,
          durationMs,
          costUsd,
        });

        logger.info(
          { sessionId: session.id, claudeSessionId, durationMs },
          'Response sent successfully',
        );
      }
    } catch (error) {
      logger.error({ error }, 'Unhandled error in message handler');
      await say({ text: '❌ An unexpected error occurred.', thread_ts: replyThreadTs });
    }
    }).catch((error) => {
      // Safety net — should never fire since inner try/catch handles everything
      logger.error({ error }, 'Unhandled error in session lock chain');
    }).finally(() => {
      // Clean up lock if we're the last item in the chain
      if (sessionLocks.get(lockKey) === currentWork) {
        sessionLocks.delete(lockKey);
      }
    });

    sessionLocks.set(lockKey, currentWork);
  });

  setupShutdownHandlers();

  // Start the bot
  const startResult = await slackClient.start();
  if (!startResult.ok) {
    console.log(chalk.red(`Error: ${startResult.error.message}`));
    process.exit(1);
  }

  // Show connection info (reuse authInfo from earlier)
  if (authInfo.ok) {
    console.log(chalk.green('✓ Goldfish started!\n'));
    console.log(`  Workspace: ${chalk.bold(authInfo.value.teamName)}`);
    console.log(`  Bot:       ${chalk.bold(authInfo.value.botName)}`);
    console.log(`  Bot ID:    ${chalk.bold(authInfo.value.botUserId)}`);
    if (listenChannels.length > 0) {
      console.log(`  Channels:  ${chalk.bold(listenChannels.join(', '))}`);
    }
    console.log('');
    console.log(`  Send a DM to ${chalk.bold(authInfo.value.botName)} in Slack to say hello!`);
    console.log('');
    console.log(chalk.dim('Listening for messages... (Ctrl+C to stop)'));
  }

  logger.info('Goldfish started and listening');
}

function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(chalk.dim(`\nReceived ${signal}, shutting down...`));
    logger.info({ signal }, 'Shutdown initiated');

    try {
      if (slackClient) {
        await slackClient.stop();
      }
      await closeDb();
      console.log(chalk.green('✓ Shutdown complete'));
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
