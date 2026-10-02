import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { createSlackClientFromEnv, type SlackBoltClient } from '../adapters/SlackBoltClient.js';
import { AgentRunnerRegistry } from '../adapters/AgentRunnerFactory.js';
import type { AgentUsage } from '../adapters/AgentRunner.js';
import { SqliteRepo } from '../adapters/SqliteRepo.js';
import { writeTranscript } from '../adapters/TranscriptWriter.js';
import { initDb, closeDb } from '../db/index.js';
import { createChildLogger } from '../lib/logger.js';
import { isHumanMessage } from '../lib/messageFilter.js';
import { formatForSlack, splitSlackMessage } from '../lib/slackFormatter.js';
import { SlackStreamUpdater } from '../lib/SlackStreamUpdater.js';
import { SlackNativeStreamer } from '../lib/SlackNativeStreamer.js';
import {
  postNativeStreamRecovery,
  type NativeStreamRecoveryResult,
} from '../lib/nativeStreamRecovery.js';
import { writeNativeStreamFailureRecord } from '../lib/nativeStreamDiagnostics.js';
import { extractToolSources } from '../lib/toolSources.js';
import { SlackFileDownloader, type SlackFile } from '../adapters/SlackFileDownloader.js';
import {
  AudioTranscriber,
  probeDurationMs,
  DEADLINE_ERROR_PREFIX,
} from '../adapters/AudioTranscriber.js';
import {
  composeUserMessage,
  hasProcessedContent,
  type VoiceMessagePart,
  type DocumentPart,
} from '../lib/composeUserMessage.js';
import { PdfTextLayer } from '../adapters/PdfTextLayer.js';
import { ErrorCodes } from '../domain/services/result.js';
import {
  SESSION_EXPIRY_MS,
  STREAMING_ENABLED,
  NATIVE_STREAMING_ENABLED,
  MAX_ATTACHMENTS_PER_MESSAGE,
  SHOW_TOOLS,
  validateWorkspace,
  validateConfiguration,
  runtimeForConversation,
  DEFAULT_BACKEND,
  BACKEND_BY_CHANNEL,
  workspaceWarnings,
  briefForChannel,
  OWNER_USER_ID,
  MAX_TRANSCRIBE_DURATION_MS,
  MAX_TRANSCRIBE_TOTAL_DURATION_MS,
  DEFAULT_TIMEOUT_MS,
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

// Per-session concurrency lock: serializes agent invocations so two messages
// in the same thread don't spawn competing processes on the same session.
const sessionLocks = new Map<string, Promise<void>>();
const activeRunControllers = new Set<AbortController>();

interface NativeStreamDeliveryRecoveryParams {
  webClient: ReturnType<SlackBoltClient['getWebClient']>;
  channelId: string;
  threadTs: string;
  messageTs: string;
  sessionId: string;
  agentSessionId?: string | null;
  backend?: 'claude' | 'codex';
  /** @deprecated compatibility for callers/tests using the old name. */
  claudeSessionId?: string | null;
  nativeStreamer: SlackNativeStreamer;
  fullText: string;
}

export async function handleNativeStreamDeliveryRecovery(
  params: NativeStreamDeliveryRecoveryParams,
): Promise<NativeStreamRecoveryResult> {
  const deliveryStatus = params.nativeStreamer.getDeliveryStatus();
  const noop: NativeStreamRecoveryResult = { attempted: false, ok: true, postedTs: [] };

  if (!deliveryStatus.suspected) {
    return noop;
  }

  logger.warn(
    {
      sessionId: params.sessionId,
      agentSessionId: params.agentSessionId ?? params.claudeSessionId ?? null,
      backend: params.backend ?? 'claude',
      claudeSessionId:
        (params.backend ?? 'claude') === 'claude'
          ? (params.claudeSessionId ?? params.agentSessionId ?? null)
          : null,
      reasons: deliveryStatus.issues.map((issue) => issue.reason),
      rawTextLength: params.fullText.length,
      unsentSuffixLength: deliveryStatus.unsentSuffixLength,
    },
    'Suspected native stream delivery gap - posting full response recovery',
  );

  const recovery = params.fullText.trim()
    ? await postNativeStreamRecovery({
        webClient: params.webClient,
        channel: params.channelId,
        threadTs: params.threadTs,
        rawText: params.fullText,
      })
    : noop;

  await writeNativeStreamFailureRecord({
    timestamp: new Date().toISOString(),
    channelId: params.channelId,
    threadTs: params.threadTs,
    messageTs: params.messageTs,
    sessionId: params.sessionId,
    agentSessionId: params.agentSessionId ?? params.claudeSessionId ?? null,
    backend: params.backend ?? 'claude',
    claudeSessionId:
      (params.backend ?? 'claude') === 'claude'
        ? (params.claudeSessionId ?? params.agentSessionId ?? null)
        : null,
    deliveryStatus,
    rawTextLength: params.fullText.length,
    rawTextPreview: params.fullText.slice(0, 500),
    recovery,
  });

  return recovery;
}

async function persistAgentSession(
  repo: SqliteRepo,
  client: SlackBoltClient,
  params: {
    sessionId: string;
    backend: 'claude' | 'codex';
    agentSessionId: string;
    expectedRevision: number;
    channel: string;
    threadTs?: string;
  },
): Promise<boolean> {
  const saved = await repo.updateAgentSession(
    params.sessionId,
    params.backend,
    params.agentSessionId,
    params.expectedRevision,
  );
  if (saved.ok && saved.value) return true;

  logger.error(
    { error: saved.ok ? undefined : saved.error, ...params },
    'Failed to persist agent session continuity',
  );
  const warning = await client.sendMessage({
    channel: params.channel,
    threadTs: params.threadTs,
    text: '⚠️ I sent the response, but couldn’t save its conversation state. Your next reply may start with incomplete context.',
  });
  if (!warning.ok) {
    logger.error({ error: warning.error, sessionId: params.sessionId }, 'Failed to send continuity warning');
  }
  return false;
}

/**
 * Start the Goldfish bot
 */
export async function start(): Promise<void> {
  console.log(chalk.bold('\n🐟 Starting Goldfish...\n'));

  const configErrors = validateConfiguration();
  if (configErrors.length > 0) {
    console.log(chalk.red(`Invalid Goldfish configuration:\n- ${configErrors.join('\n- ')}`));
    process.exit(1);
  }

  const configuredBackends = new Set<'claude' | 'codex'>([DEFAULT_BACKEND]);
  for (const backend of Object.values(BACKEND_BY_CHANNEL)) {
    if (backend === 'claude' || backend === 'codex') configuredBackends.add(backend);
  }

  // Validate every configured route before accepting Slack messages.
  for (const backend of configuredBackends) {
    const workspaceError = validateWorkspace(backend);
    if (workspaceError) {
      console.log(chalk.red(workspaceError));
      process.exit(1);
    }
    for (const warning of workspaceWarnings(backend)) {
      console.log(chalk.yellow(`⚠ ${warning}`));
    }
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

  const runners = new AgentRunnerRegistry();

  // Create file downloader (for Slack image/attachment handling)
  const slackBotToken = process.env.SLACK_BOT_TOKEN ?? '';
  const fileDownloader = new SlackFileDownloader(slackBotToken);
  const audioTranscriber = new AudioTranscriber();
  const pdfTextLayer = new PdfTextLayer();

  // Verify every configured runtime, including channel-specific overrides.
  for (const backend of configuredBackends) {
    const runnerCheck = await runners.get(backend).checkAvailable();
    if (!runnerCheck.ok) {
      console.log(chalk.yellow(`⚠ Warning: ${runnerCheck.error.message}`));
      console.log(chalk.yellow(`  ${backend} routes will respond with errors until it is available.`));
    }
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
    // Keep only what a human actually typed. See messageFilter.ts — a subtype
    // missing from that allowlist vanishes with no error anywhere, which is how
    // "also send to channel" replies were silently lost.
    if (!isHumanMessage(msg.subtype)) return;
    if (msg.user === undefined || msg.user === '') return;

    // Don't respond to our own messages (prevents loops in channels)
    if (botUserId && msg.user === botUserId) return;

    // Deduplicate Slack event retries — Socket Mode re-delivers the same event
    // if the ack doesn't arrive in time (e.g. during a reconnect). The ts is
    // the immutable Slack message ID, so a second delivery of the same ts
    // with the same direction means we already handled it.
    if (await repo.hasProcessedSlackTs(msg.ts)) {
      logger.info({ messageTs: msg.ts }, 'Dropping duplicate Slack event (already processed)');
      return;
    }

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
    // If an agent run is already active for this thread, queue the
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
      // before session lookup, file downloads, or provider invocation, so the user
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

    const leaseOwner = randomUUID();
    let leasedSessionId: string | null = null;
    let runController: AbortController | null = null;
    try {
      // Get or create session
      const sessionResult = await repo.getOrCreateSession(channelId, sessionKey);
      if (!sessionResult.ok) {
        logger.error({ error: sessionResult.error }, 'Failed to get/create session');
        await say({ text: '❌ Internal error: Could not create session.', thread_ts: replyThreadTs });
        return;
      }

      const session = sessionResult.value;

      const lease = await repo.acquireRunLease(
        session.id,
        leaseOwner,
        DEFAULT_TIMEOUT_MS + 60_000,
      );
      if (!lease.ok || !lease.value) {
        logger.warn({ sessionId: session.id }, 'Session is leased by another Goldfish process');
        await say({
          text: '⏳ I’m still handling another message in this conversation. Please try again shortly.',
          thread_ts: replyThreadTs,
        });
        return;
      }
      leasedSessionId = session.id;
      runController = new AbortController();
      activeRunControllers.add(runController);

      const runtime = runtimeForConversation(channelId, session);
      const runner = runners.get(runtime.backend);
      const expectedSessionRevision = session.agentSessionRevision;
      const runtimeWorkspaceError = validateWorkspace(runtime.backend);
      if (runtimeWorkspaceError) {
        logger.error({ backend: runtime.backend }, runtimeWorkspaceError);
        await say({ text: `❌ ${runtimeWorkspaceError}`, thread_ts: replyThreadTs });
        return;
      }

      // Check session expiry — if too old, start fresh (don't resume stale context)
      let resumeSessionId =
        session.agentBackend === runtime.backend ? session.agentSessionId : null;
      if (session.agentBackend && session.agentBackend !== runtime.backend) {
        logger.info(
          { sessionId: session.id, from: session.agentBackend, to: runtime.backend },
          'Starting fresh context for requested backend switch',
        );
      }
      const sessionAge = Date.now() - (session.agentSessionActiveAt ?? 0);
      if (resumeSessionId && sessionAge > SESSION_EXPIRY_MS) {
        logger.info(
          { sessionId: session.id, ageMs: sessionAge },
          'Session expired, starting fresh',
        );
        resumeSessionId = null;
      }

      // Computed before the attachment block, not after: the scope-missing
      // reply below contains developer instructions that must never be shown
      // to anyone but the owner.
      const senderIsOwner = OWNER_USER_ID ? msg.user === OWNER_USER_ID : true;
      const imagePaths: string[] = [];

      // Download any file attachments (images, PDFs, text, code, etc.)
      // and fold them into the prompt as [Attached file: <path>] markers.
      // The agent's personality (from the provider bootstrap / IDENTITY.md)
      // handles the response naturally — no instructional prose injected.
      if (hasFiles) {
        const filesToProcess = msg.files!.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
        const attachmentPaths: string[] = [];
        const voiceParts: VoiceMessagePart[] = [];
        const documentParts: DocumentPart[] = [];
        const skipped: string[] = [];
        let scopeMissing = false;
        // Transcription is synchronous and runs inside the per-session lock, so
        // the budget is per MESSAGE, not per file: MAX_ATTACHMENTS_PER_MESSAGE
        // is 10, and a per-file cap alone would let one message tie the thread
        // up for an hour and a half.
        let transcribedMs = 0;
        // Circuit breaker. Killing mw does not cancel the job inside
        // MacWhisper.app, so once one file has hit the deadline every later
        // one queues behind that orphan and waits its own full deadline. Ten
        // 89-second notes would sit inside the lock for ~11 minutes.
        let transcriberWedged = false;
        // Same reasoning as transcriberWedged: if OCR blew its deadline once,
        // the next scan in the same message will too, and each one is another
        // minute of the session lock held.
        let ocrWedged = false;

        for (const file of filesToProcess) {
          const downloadResult = await fileDownloader.download(file);

          if (!downloadResult.ok) {
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
            continue;
          }

          const downloaded = downloadResult.value;
          const isAudio =
            downloaded.isVoiceMessage ||
            downloaded.mimetype.toLowerCase().startsWith('audio/');

          const isPdf =
            downloaded.mimetype.toLowerCase() === 'application/pdf' ||
            downloaded.path.toLowerCase().endsWith('.pdf');
          const isImage = downloaded.mimetype.toLowerCase().startsWith('image/');

          if (isPdf) {
            // Cheap first (44ms on a 33MB file): does it already have text?
            // A scan yields one form-feed per page and nothing else.
            const existing = await pdfTextLayer.extractText(downloaded.path);
            const pages = await pdfTextLayer.pageCount(downloaded.path);

            if (!pages || !pdfTextLayer.needsOcr(existing, pages)) {
              attachmentPaths.push(downloaded.path);
              continue;
            }

            if (ocrWedged) {
              documentParts.push({
                state: 'ocr_failed',
                originalPath: downloaded.path,
                pageCount: pages,
              });
              attachmentPaths.push(downloaded.path);
              continue;
            }

            const ocr = await pdfTextLayer.addTextLayer(downloaded.path, pages);
            if (ocr.ok) {
              documentParts.push({
                state: 'ocr_added',
                originalPath: downloaded.path,
                pageCount: pages,
                markdownPath: ocr.value.markdownPath,
                ocrPdfPath: ocr.value.ocrPdfPath,
                lowConfidencePages: ocr.value.lowConfidencePages,
              });
              // Only the markdown is attached. The 31MB PDF stays a path in
              // the marker — reading it means rendering page images, which is
              // the right tool for checking a figure and the wrong one for
              // finding it.
              attachmentPaths.push(ocr.value.markdownPath);
            } else {
              const tooLarge = ocr.error.code === ErrorCodes.PDF_OCR_TOO_LARGE;
              if (!tooLarge) ocrWedged = true;
              documentParts.push({
                state: tooLarge ? 'too_many_pages' : 'ocr_failed',
                originalPath: downloaded.path,
                pageCount: pages,
              });
              // No text layer, so the page images are all there is.
              attachmentPaths.push(downloaded.path);
              logger.warn(
                { error: ocr.error, fileId: file.id, pages },
                'PDF OCR unsuccessful',
              );
            }
            continue;
          }

          if (!isAudio) {
            // Codex receives images as structured local-image inputs. Avoid
            // also presenting the same file as an attachment-path marker.
            if (isImage && runtime.backend === 'codex') imagePaths.push(downloaded.path);
            else attachmentPaths.push(downloaded.path);
            continue;
          }

          // An unknown duration must not mean "unlimited" — that is how an
          // hour-long recording reaches a transcriber holding the session lock.
          // Slack gives duration_ms for voice notes but not necessarily for an
          // ordinary upload, so probe, then fail closed.
          const durationMs =
            downloaded.durationMs ?? (await probeDurationMs(downloaded.path));

          const part: VoiceMessagePart = {
            kind: downloaded.isVoiceMessage ? 'voice' : 'recording',
            state: 'transcribed',
            audioPath: downloaded.path,
            durationMs,
          };

          if (durationMs === undefined) {
            part.state = 'unknown_duration';
          } else if (
            durationMs > MAX_TRANSCRIBE_DURATION_MS ||
            transcribedMs + durationMs > MAX_TRANSCRIBE_TOTAL_DURATION_MS
          ) {
            part.state = 'too_long';
          } else if (transcriberWedged) {
            part.state = 'failed';
          } else {
            transcribedMs += durationMs;
            const transcription = await audioTranscriber.transcribe(
              downloaded.path,
              durationMs,
            );
            if (transcription.ok) {
              part.transcript = transcription.value;
              part.transcriptPath = `${downloaded.path}.txt`;
            } else {
              part.state =
                transcription.error.code === ErrorCodes.AUDIO_NO_SPEECH
                  ? 'no_speech'
                  : 'failed';
              if (transcription.error.message.startsWith(DEADLINE_ERROR_PREFIX)) {
                transcriberWedged = true;
              }
              logger.warn(
                { error: transcription.error, fileId: file.id },
                'Audio transcription unsuccessful',
              );
            }
          }

          // Either way the audio path lives only in the marker, never in
          // attachmentPaths — the agent treats those as Read targets and
          // cannot open an .m4a. For an uploaded recording the transcript
          // travels as the attachment instead of being inlined: it is not
          // something the sender said into Slack, and a nine-minute meeting
          // would put ~1500 words in the prompt twice over.
          if (part.kind === 'recording' && part.transcriptPath) {
            attachmentPaths.push(part.transcriptPath);
          }
          voiceParts.push(part);
        }

        // Compose BEFORE any guard runs. Appending voice content afterwards is
        // how a voice-only message gets silently discarded by the "nothing to
        // send" check below.
        userMessage = composeUserMessage({
          text: userMessage,
          attachmentPaths,
          voiceParts,
          documentParts,
          skipped,
        });
        if (imagePaths.length > 0 && !userMessage.trim()) {
          userMessage = '[Attached image]';
        }

        // Scope missing is a special case — tell the OWNER how to fix it.
        // Anyone else gets a plain apology: the fix is developer instructions
        // ("add the files:read scope, reinstall the app"), and delivering those
        // to, say, a parent in a shared channel is noise they can't act on.
        if (scopeMissing && !hasProcessedContent({ attachmentPaths, voiceParts, documentParts })) {
          await say({
            text: senderIsOwner
              ? '📎 I can see your attachment, but my Slack app is missing the `files:read` scope. ' +
                'Add it in the Goldfish app\'s OAuth settings and reinstall to enable attachment support.'
              : '📎 I can see you sent something, but I wasn\'t able to open it — sorry.',
            thread_ts: replyThreadTs,
          });
          return;
        }

        // If everything failed and there's no text, don't invoke the agent
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
            voiceCount: voiceParts.length,
            documentCount: documentParts.length,
            transcribedMs,
            skippedCount: skipped.length,
          },
          'Processed message attachments',
        );
      }

      // --- Sender + room context ---
      // A Slack message arrives as bare text: no author, no room. In a channel
      // with more than one human the agent cannot tell who it is talking to and
      // will assume it is the owner. Prepend the facts it cannot otherwise know.
      // Added after a session answered JD's dad with JD's private status board.
      if (isListenChannel || !senderIsOwner) {
        const senderId = msg.user ?? 'unknown';
        const senderName = await slackClient!.getUserDisplayName(senderId);
        const brief = briefForChannel(channelId);
        const header = [
          `[Goldfish context — not written by the sender]`,
          `Channel: ${channelId}`,
          // Trace only — GOLDFISH_THREAD_TS is what send/upload actually read.
          // This header is gated on channel/non-owner, so it is NOT the carrier.
          msg.thread_ts ? `Thread: ${msg.thread_ts}` : null,
          `Message from: ${senderName} (${senderId})`,
          brief ? `Channel note: ${brief}` : null,
          `[end context]`,
        ]
          .filter(Boolean)
          .join('\n');
        userMessage = `${header}\n\n${userMessage}`;
      }

      // Save inbound message
      await repo.saveMessage({
        sessionId: session.id,
        slackTs: msg.ts,
        direction: 'inbound',
        content: userMessage,
      });

      // Run the selected agent backend and send its response
      logger.info(
        {
          sessionId: session.id,
          resumeSessionId,
          streaming: STREAMING_ENABLED,
          nativeStreaming: STREAMING_ENABLED && NATIVE_STREAMING_ENABLED,
        },
        'Invoking agent runtime',
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
        let agentSessionId: string | undefined;
        let durationMs: number | undefined;
        let costUsd: number | undefined;
        let usage: AgentUsage | undefined;
        let nativeRecovery: NativeStreamRecoveryResult = {
          attempted: false,
          ok: true,
          postedTs: [],
        };

        try {
          nativeStreamer.start();

          const stream = runner.runStream({
            prompt: userMessage,
            resumeSessionId: resumeSessionId ?? undefined,
            effort: runtime.effort,
            model: runtime.model,
            // chat.startStream renders markdown server-side, so the model is
            // told tables are available. The legacy branch below must not.
            nativeMarkdown: true,
            // The agent inherits the destination ITS OWN reply is going to, so
            // a file it uploads lands beside its words. This branch delivers
            // to streamThreadTs (always threaded), not replyThreadTs.
            slackChannelId: channelId,
            slackThreadTs: streamThreadTs,
            signal: runController.signal,
            imagePaths: runtime.backend === 'codex' ? imagePaths : undefined,
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
                // Intentionally no-op: tool_result is the authoritative
                // completion event used by the Slack task timeline.
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
                agentSessionId = event.sessionId;
                durationMs = event.durationMs;
                costUsd = event.costUsd;
                usage = event.usage;
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

          nativeRecovery = await handleNativeStreamDeliveryRecovery({
            webClient: slackClient!.getWebClient(),
            channelId,
            threadTs: streamThreadTs,
            messageTs: msg.ts,
            sessionId: session.id,
            agentSessionId: agentSessionId ?? null,
            backend: runtime.backend,
            nativeStreamer,
            fullText: result,
          });
        } catch (error) {
          logger.error({ error, backend: runtime.backend }, 'Native streaming agent invocation failed');
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          // Abort the stream with a short error marker. We can't pass the
          // full accumulated text because chat.stopStream({markdown_text})
          // APPENDS rather than replaces, which would duplicate everything.
          const accumulated = nativeStreamer.getRawText();
          const fallbackText = accumulated
            ? `_⚠️ Response interrupted: ${errorMessage}_`
            : `❌ Error: ${errorMessage}`;

          await nativeStreamer.abort(fallbackText);

          result = accumulated;
          const deliveryStatus = nativeStreamer.getDeliveryStatus();
          if (deliveryStatus.suspected) {
            nativeRecovery = await handleNativeStreamDeliveryRecovery({
              webClient: slackClient!.getWebClient(),
              channelId,
              threadTs: streamThreadTs,
              messageTs: msg.ts,
              sessionId: session.id,
              agentSessionId: agentSessionId ?? null,
              backend: runtime.backend,
              nativeStreamer,
              fullText: accumulated,
            });
          } else {
            // If there's unsent suffix text from a straightforward thrown
            // append failure, post it through the same split/retried helper.
            const unsent = nativeStreamer.getUnsentText();
            if (unsent.trim()) {
              logger.info(
                { unsentLength: unsent.length },
                'Posting unsent text as follow-up message after stream failure',
              );
              nativeRecovery = await postNativeStreamRecovery({
                webClient: slackClient!.getWebClient(),
                channel: channelId,
                threadTs: streamThreadTs,
                rawText: unsent,
              });
            }
          }

          if (result.trim()) {
            logger.info(
              {
                deliverySuspected: deliveryStatus.suspected,
                recoveryAttempted: nativeRecovery.attempted,
                recoveryOk: nativeRecovery.ok,
              },
              'Persisting interrupted native streaming response',
            );
            if (agentSessionId) {
              await persistAgentSession(repo, slackClient!, {
                sessionId: session.id,
                backend: runtime.backend,
                agentSessionId,
                expectedRevision: expectedSessionRevision,
                channel: channelId,
                threadTs: streamThreadTs,
              });
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
              agentSessionId: agentSessionId ?? null,
              backend: runtime.backend,
              model: runtime.model,
              durationMs,
              costUsd,
              usage,
            });
          }

          return;
        }

        if (agentSessionId) {
          await persistAgentSession(repo, slackClient!, {
            sessionId: session.id,
            backend: runtime.backend,
            agentSessionId,
            expectedRevision: expectedSessionRevision,
            channel: channelId,
            threadTs: streamThreadTs,
          });
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
          agentSessionId: agentSessionId ?? null,
          backend: runtime.backend,
          model: runtime.model,
          durationMs,
          costUsd,
          usage,
        });

        const deliveryStatus = nativeStreamer.getDeliveryStatus();
        logger.info(
          {
            sessionId: session.id,
            agentSessionId,
            backend: runtime.backend,
            durationMs,
            deliverySuspected: deliveryStatus.suspected,
            deliveryReasons: deliveryStatus.issues.map((issue) => issue.reason),
            recovered: nativeRecovery.attempted ? nativeRecovery.ok : false,
            recoveryPostedTs: nativeRecovery.postedTs,
          },
          'Native streaming response completed',
        );
      } else if (STREAMING_ENABLED) {
        // Streaming path: progressive Slack updates (lazy-posted on first content)
        const updater = new SlackStreamUpdater(slackClient!, channelId, replyThreadTs);
        await updater.start();
        // Note: start() no longer posts anything. The updater will lazy-post
        // the first message when real content (text or tool status) arrives.

        let result = '';
        let agentSessionId: string | undefined;
        let durationMs: number | undefined;
        let costUsd: number | undefined;
        let usage: AgentUsage | undefined;

        try {
          const stream = runner.runStream({
            prompt: userMessage,
            resumeSessionId: resumeSessionId ?? undefined,
            effort: runtime.effort,
            model: runtime.model,
            // This branch delivers via SlackStreamUpdater(replyThreadTs).
            slackChannelId: channelId,
            slackThreadTs: replyThreadTs,
            signal: runController.signal,
            imagePaths: runtime.backend === 'codex' ? imagePaths : undefined,
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
                // Intentionally no-op: the next text phase or tool result
                // clears/replaces the legacy status display.
                break;
              case 'result':
                result = event.result;
                agentSessionId = event.sessionId;
                durationMs = event.durationMs;
                costUsd = event.costUsd;
                usage = event.usage;
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
          logger.error({ error, backend: runtime.backend }, 'Streaming agent invocation failed');
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await updater.abort(`❌ Error: ${errorMessage}`);
          return;
        }

        if (agentSessionId) {
          await persistAgentSession(repo, slackClient!, {
            sessionId: session.id,
            backend: runtime.backend,
            agentSessionId,
            expectedRevision: expectedSessionRevision,
            channel: channelId,
            threadTs: replyThreadTs,
          });
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
          agentSessionId: agentSessionId ?? null,
          backend: runtime.backend,
          model: runtime.model,
          durationMs,
          costUsd,
          usage,
        });

        logger.info(
          { sessionId: session.id, agentSessionId, backend: runtime.backend, durationMs },
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

        const agentResult = await runner.run({
          prompt: userMessage,
          resumeSessionId: resumeSessionId ?? undefined,
          effort: runtime.effort,
          model: runtime.model,
          // This branch delivers via say({ thread_ts: replyThreadTs }).
          slackChannelId: channelId,
          slackThreadTs: replyThreadTs,
          signal: runController.signal,
          imagePaths: runtime.backend === 'codex' ? imagePaths : undefined,
        });

        if (!agentResult.ok) {
          logger.error({ error: agentResult.error, backend: runtime.backend }, 'Agent invocation failed');
          if (thinkingTs) {
            await slackClient!.updateMessage({
              channel: channelId,
              ts: thinkingTs,
              text: `❌ Error: ${agentResult.error.message}`,
            });
          } else {
            await say({ text: `❌ Error: ${agentResult.error.message}`, thread_ts: replyThreadTs });
          }
          return;
        }

        const { result, sessionId: agentSessionId, durationMs, costUsd, usage } = agentResult.value;
        const formattedResult = formatForSlack(result);

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

        if (agentSessionId) {
          await persistAgentSession(repo, slackClient!, {
            sessionId: session.id,
            backend: runtime.backend,
            agentSessionId,
            expectedRevision: expectedSessionRevision,
            channel: channelId,
            threadTs: replyThreadTs,
          });
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
          agentSessionId: agentSessionId ?? null,
          backend: runtime.backend,
          model: runtime.model,
          durationMs,
          costUsd,
          usage,
        });

        logger.info(
          { sessionId: session.id, agentSessionId, backend: runtime.backend, durationMs },
          'Response sent successfully',
        );
      }
    } catch (error) {
      logger.error({ error }, 'Unhandled error in message handler');
      await say({ text: '❌ An unexpected error occurred.', thread_ts: replyThreadTs });
    } finally {
      if (runController) activeRunControllers.delete(runController);
      if (leasedSessionId) {
        await repo.releaseRunLease(leasedSessionId, leaseOwner);
      }
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
      for (const controller of activeRunControllers) controller.abort();
      if (slackClient) {
        await slackClient.stop();
      }
      if (sessionLocks.size > 0) {
        await Promise.race([
          Promise.allSettled([...sessionLocks.values()]),
          new Promise((resolve) => setTimeout(resolve, 10_000)),
        ]);
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
