import { spawn } from 'child_process';
import {
  type Result,
  ok,
  err,
  createError,
  ErrorCodes,
} from '../domain/services/result.js';
import { createChildLogger } from '../lib/logger.js';
import { WORKSPACE_PATH, DEFAULT_MAX_TURNS, DEFAULT_TIMEOUT_MS } from '../config.js';
import { StreamEventParser, type StreamEvent } from './StreamEventParser.js';
import {
  buildAgentEnv,
  type AgentResponse,
  type AgentRunParams,
  type AgentRunner,
} from './AgentRunner.js';

const logger = createChildLogger('ClaudeRunner');
const SYNTHESIS_SYSTEM_PROMPT =
  'You are a memory synthesis assistant. Output only the requested markdown. Do not use tools and do not ask questions.';

export type ClaudeResponse = AgentResponse;
export type ClaudeRunParams = AgentRunParams;
export { buildAgentEnv } from './AgentRunner.js';

/**
 * Slack formatting guidance, appended to the system prompt at session creation.
 *
 * There are two delivery surfaces and they have different capabilities:
 *
 *  - LEGACY (`chat.postMessage` / `chat.update`): output passes through
 *    `formatForSlack()`, which flattens markdown tables to bullet rows and
 *    headers to bold text. Used by `initiate` briefings and by both
 *    non-native branches in `cli/start.ts`.
 *  - NATIVE (`chat.startStream`): Slack renders markdown server-side and
 *    tables arrive as real Slack table elements. Raw model output is sent
 *    as-is — `formatForSlack()` never runs.
 *
 * Only the caller knows which surface it is delivering to, so this is a
 * parameter rather than a module-level flag: `runStream()` serves both the
 * native branch (start.ts) and the legacy streaming branch.
 *
 * NOTE (2026-09-11): table support on the native path is verified. The
 * remaining rules below are inherited from the original 2026-04-04 prompt and
 * are NOT yet tested against native rendering — headers, `**bold**` and
 * numbered lists may also be stale. Verify before relaxing them.
 */
export const SLACK_FORMATTING_LEGACY = `You are responding via Slack. Format output for Slack's limited markdown ("mrkdwn"):

SLACK FORMATTING RULES:
- NO TABLES - Slack cannot render them. Use bullet lists or simple text instead.
- NO HEADERS (# ## ###) - Use *bold text* on its own line instead.
- Bold: use *single asterisks* not **double**
- Italic: use _underscores_ not *single asterisks*
- Code: \`inline\` and \`\`\`blocks\`\`\` work fine
- Links: <url|text> format (but standard [text](url) will be converted)
- Bullet lists work, but numbered lists render poorly

INSTEAD OF TABLES, USE:
• Bullet lists with bold labels: *Label:* value
• Simple key: value pairs on separate lines
• Short summaries instead of data grids

Keep responses concise. If running long operations, acknowledge first.`;

/**
 * Native-streaming variant. Identical to the legacy prompt except that real
 * markdown tables are supported and preferred for tabular data.
 */
export const SLACK_FORMATTING_NATIVE = `You are responding via Slack via the native streaming API, which renders markdown server-side.

SLACK FORMATTING RULES:
- TABLES RENDER NATIVELY - use real markdown tables for tabular data. Do not flatten a comparison into bullet rows.
- NO HEADERS (# ## ###) - Use *bold text* on its own line instead.
- Bold: use *single asterisks* not **double**
- Italic: use _underscores_ not *single asterisks*
- Code: \`inline\` and \`\`\`blocks\`\`\` work fine
- Links: <url|text> format (but standard [text](url) will be converted)
- Bullet lists work, but numbered lists render poorly

Keep responses concise. If running long operations, acknowledge first.`;

/** Pick the formatting guidance that matches the caller's delivery surface. */
export function slackSystemPrompt(nativeMarkdown: boolean | undefined): string {
  return nativeMarkdown ? SLACK_FORMATTING_NATIVE : SLACK_FORMATTING_LEGACY;
}

/**
 * Runner for spawning Claude Code CLI
 */
export class ClaudeRunner implements AgentRunner {
  readonly backend = 'claude' as const;
  readonly capabilities = { textDeltas: true, toolEvents: true, imageInputs: false };
  private claudePath: string;

  constructor(claudePath: string = 'claude') {
    this.claudePath = claudePath;
  }

  /**
   * Run Claude with a prompt
   */
  async run(params: ClaudeRunParams): Promise<Result<ClaudeResponse>> {
    const {
      prompt,
      resumeSessionId,
      maxTurns = DEFAULT_MAX_TURNS,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      model,
      effort,
      nativeMarkdown,
      slackChannelId,
      slackThreadTs,
      signal,
      profile,
      workingDirectory,
    } = params;

    const args: string[] = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--max-turns',
      String(maxTurns),
      '--dangerously-skip-permissions',
    ];

    if (model) {
      args.push('--model', model);
    }

    if (effort) {
      args.push('--effort', effort);
    }

    if (profile === 'synthesis') {
      args.push('--tools', '', '--system-prompt', SYNTHESIS_SYSTEM_PROMPT);
    } else if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      args.push('--append-system-prompt', slackSystemPrompt(nativeMarkdown));
    }

    logger.info(
      {
        promptLength: prompt.length,
        resumeSessionId,
        maxTurns,
        timeoutMs,
        model,
        effort,
      },
      'Spawning Claude CLI',
    );

    const startTime = Date.now();

    try {
      const output = await this.spawnClaude(
        args,
        timeoutMs,
        buildAgentEnv(process.env, { slackChannelId, slackThreadTs }),
        signal,
        workingDirectory,
      );
      const durationMs = Date.now() - startTime;

      const response = ClaudeRunner.parseResponse(output);
      if (!response.ok) {
        return response;
      }

      logger.info(
        {
          sessionId: response.value.sessionId,
          durationMs,
          resultLength: response.value.result.length,
        },
        'Claude CLI completed',
      );

      return ok({
        ...response.value,
        backend: 'claude',
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error({ error, durationMs }, 'Claude CLI failed');

      if (error instanceof Error && error.message.includes('timeout')) {
        return err(
          createError(
            ErrorCodes.CLAUDE_TIMEOUT,
            `Claude CLI timed out after ${timeoutMs}ms`,
            error,
          ),
        );
      }

      return err(
        createError(ErrorCodes.CLAUDE_SPAWN_FAILED, 'Claude CLI failed', error),
      );
    }
  }

  /**
   * Spawn Claude process and capture output
   */
  private spawnClaude(
    args: string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv = buildAgentEnv(process.env),
    signal?: AbortSignal,
    workingDirectory: string = WORKSPACE_PATH,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.claudePath, args, {
        cwd: workingDirectory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const forceKill = () => setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 2_000).unref();
      const onAbort = () => {
        proc.kill('SIGTERM');
        forceKill();
        reject(new Error('Claude CLI aborted'));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        forceKill();
        reject(new Error(`Claude CLI timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);

        if (code !== 0) {
          logger.error(
            { code, stderr, stdout: stdout.substring(0, 1000) },
            'Claude CLI exited with error',
          );
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
          return;
        }

        resolve(stdout);
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  /**
   * Parse Claude JSON response
   */
  static parseResponse(output: string): Result<ClaudeResponse> {
    try {
      const json = JSON.parse(output.trim());

      const result = json.result ?? json.response ?? '';
      const sessionId = json.session_id ?? json.sessionId ?? '';

      if (!sessionId) {
        logger.warn({ json }, 'No session ID in Claude response');
      }

      return ok({
        backend: 'claude',
        result,
        sessionId,
        costUsd: json.cost_usd ?? json.costUsd,
        numTurns: json.num_turns ?? json.numTurns,
      });
    } catch (error) {
      logger.error(
        { error, output: output.substring(0, 500) },
        'Failed to parse Claude response',
      );
      return err(
        createError(
          ErrorCodes.CLAUDE_PARSE_ERROR,
          'Failed to parse Claude CLI response',
          error,
        ),
      );
    }
  }

  /**
   * Run Claude with streaming output.
   * Yields StreamEvent items as they arrive from the CLI.
   * The final ClaudeResponse is returned when the generator completes.
   */
  async *runStream(params: ClaudeRunParams): AsyncGenerator<StreamEvent, ClaudeResponse | undefined> {
    const {
      prompt,
      resumeSessionId,
      maxTurns = DEFAULT_MAX_TURNS,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      model,
      effort,
      nativeMarkdown,
      slackChannelId,
      slackThreadTs,
      signal,
      profile,
      workingDirectory,
    } = params;

    const args: string[] = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--max-turns',
      String(maxTurns),
      '--dangerously-skip-permissions',
    ];

    if (model) {
      args.push('--model', model);
    }

    if (effort) {
      args.push('--effort', effort);
    }

    if (profile === 'synthesis') {
      args.push('--tools', '', '--system-prompt', SYNTHESIS_SYSTEM_PROMPT);
    } else if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      args.push('--append-system-prompt', slackSystemPrompt(nativeMarkdown));
    }

    logger.info(
      {
        promptLength: prompt.length,
        resumeSessionId,
        maxTurns,
        timeoutMs,
        model,
        effort,
        streaming: true,
      },
      'Spawning Claude CLI (streaming)',
    );

    const startTime = Date.now();
    let finalResponse: ClaudeResponse | undefined;

    // Create a queue for async iteration
    const eventQueue: StreamEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let streamError: Error | null = null;

    const parser = new StreamEventParser((event) => {
      if (event.type === 'result') {
        finalResponse = {
          backend: 'claude',
          result: event.result,
          sessionId: event.sessionId,
          costUsd: event.costUsd,
          numTurns: event.numTurns,
          durationMs: event.durationMs ?? (Date.now() - startTime),
        };
      }
      eventQueue.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    const proc = spawn(this.claudePath, args, {
      cwd: workingDirectory ?? WORKSPACE_PATH,
      env: buildAgentEnv(process.env, { slackChannelId, slackThreadTs }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      parser.feed(data.toString());
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 2_000).unref();
      streamError = new Error(`Claude CLI timeout after ${timeoutMs}ms`);
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    }, timeoutMs);

    const onAbort = () => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 2_000).unref();
      streamError = new Error('Claude CLI aborted');
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      parser.flush();

      if (code !== 0 && !streamError) {
        logger.error(
          { code, stderr: stderr.substring(0, 1000) },
          'Claude CLI (streaming) exited with error',
        );
        streamError = new Error(`Claude CLI exited with code ${code}: ${stderr}`);
      }

      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      streamError = error;
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    try {
      // Yield events as they arrive
      while (!done || eventQueue.length > 0) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        } else if (!done) {
          await new Promise<void>((r) => { resolve = r; });
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!done && proc.exitCode === null) {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        }, 2_000).unref();
      }
    }

    if (streamError) {
      throw streamError;
    }

    const durationMs = Date.now() - startTime;
    if (finalResponse) {
      finalResponse.durationMs = durationMs;
    }

    logger.info(
      {
        sessionId: finalResponse?.sessionId,
        durationMs,
        resultLength: finalResponse?.result.length,
      },
      'Claude CLI (streaming) completed',
    );

    return finalResponse;
  }

  /**
   * Check if Claude CLI is available
   */
  async checkAvailable(): Promise<Result<string>> {
    return new Promise((resolve) => {
      const proc = spawn(this.claudePath, ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(ok(stdout.trim()));
        } else {
          resolve(
            err(
              createError(
                ErrorCodes.CLAUDE_SPAWN_FAILED,
                `Claude CLI not available (exit code ${code})`,
              ),
            ),
          );
        }
      });

      proc.on('error', (error) => {
        resolve(
          err(
            createError(
              ErrorCodes.CLAUDE_SPAWN_FAILED,
              'Claude CLI not found in PATH',
              error,
            ),
          ),
        );
      });
    });
  }
}
