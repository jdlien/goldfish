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

const logger = createChildLogger('ClaudeRunner');

export interface ClaudeResponse {
  result: string;
  sessionId: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export interface ClaudeRunParams {
  prompt: string;
  resumeSessionId?: string;
  maxTurns?: number;
  timeoutMs?: number;
  model?: string;
}

const SLACK_SYSTEM_PROMPT = `You are responding via Slack. Format output for Slack's limited markdown ("mrkdwn"):

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
 * Runner for spawning Claude Code CLI
 */
export class ClaudeRunner {
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

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      args.push('--append-system-prompt', SLACK_SYSTEM_PROMPT);
    }

    logger.info(
      {
        promptLength: prompt.length,
        resumeSessionId,
        maxTurns,
        timeoutMs,
        model,
      },
      'Spawning Claude CLI',
    );

    const startTime = Date.now();

    try {
      const output = await this.spawnClaude(args, timeoutMs);
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
  private spawnClaude(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.claudePath, args, {
        cwd: WORKSPACE_PATH,
        env: {
          ...process.env,
          NO_COLOR: '1',
          GOLDFISH_SESSION: '1',
        },
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

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Claude CLI timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);

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

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      args.push('--append-system-prompt', SLACK_SYSTEM_PROMPT);
    }

    logger.info(
      {
        promptLength: prompt.length,
        resumeSessionId,
        maxTurns,
        timeoutMs,
        model,
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
      cwd: WORKSPACE_PATH,
      env: {
        ...process.env,
        NO_COLOR: '1',
        GOLDFISH_SESSION: '1',
      },
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
      streamError = new Error(`Claude CLI timeout after ${timeoutMs}ms`);
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
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
      streamError = error;
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    // Yield events as they arrive
    while (!done || eventQueue.length > 0) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      } else if (!done) {
        await new Promise<void>((r) => { resolve = r; });
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
