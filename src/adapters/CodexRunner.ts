import { spawn } from 'child_process';
import { createRequire } from 'module';
import {
  Codex,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadItem,
  type WebSearchMode,
} from '@openai/codex-sdk';
import {
  type Result,
  ok,
  err,
  createError,
  ErrorCodes,
} from '../domain/services/result.js';
import {
  DEFAULT_TIMEOUT_MS,
  WORKSPACE_PATH,
} from '../config.js';
import { createChildLogger } from '../lib/logger.js';
import type { StreamEvent } from './StreamEventParser.js';
import { slackSystemPrompt } from './ClaudeRunner.js';
import {
  buildAgentEnv,
  stringEnv,
  type AgentResponse,
  type AgentRunParams,
  type AgentRunner,
} from './AgentRunner.js';

const logger = createChildLogger('CodexRunner');

interface CodexRunnerOptions {
  codexPath?: string;
  defaultSandbox?: SandboxMode;
  defaultNetworkAccess?: boolean;
  defaultWebSearchMode?: WebSearchMode;
  defaultAdditionalDirectories?: string[];
}

function bundledCodexEntry(): string {
  const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
  return sdkRequire.resolve('@openai/codex/bin/codex.js');
}

function combineAbort(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Codex timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
    didTimeout: () => timedOut,
  };
}

function toolName(item: ThreadItem): string | undefined {
  switch (item.type) {
    case 'command_execution':
      return 'Shell';
    case 'file_change':
      return 'File change';
    case 'mcp_tool_call':
      return `${item.server}.${item.tool}`;
    case 'web_search':
      return 'Web search';
    default:
      return undefined;
  }
}

function toolInput(item: ThreadItem): unknown {
  switch (item.type) {
    case 'command_execution':
      return { command: item.command };
    case 'file_change':
      return { changes: item.changes };
    case 'mcp_tool_call':
      return item.arguments;
    case 'web_search':
      return { query: item.query };
    default:
      return undefined;
  }
}

function toolOutput(item: ThreadItem): { output: string; isError: boolean } {
  switch (item.type) {
    case 'command_execution':
      return {
        output: item.aggregated_output,
        isError: item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0),
      };
    case 'file_change':
      return { output: JSON.stringify(item.changes), isError: item.status === 'failed' };
    case 'mcp_tool_call':
      return {
        output: item.error?.message ?? JSON.stringify(item.result ?? ''),
        isError: item.status === 'failed',
      };
    case 'web_search':
      return { output: item.query, isError: false };
    default:
      return { output: '', isError: false };
  }
}

export class CodexRunner implements AgentRunner {
  readonly backend = 'codex' as const;
  readonly capabilities = { textDeltas: false, toolEvents: true, imageInputs: true };

  private readonly codexPath?: string;
  private readonly defaultSandbox: SandboxMode;
  private readonly defaultNetworkAccess: boolean;
  private readonly defaultWebSearchMode: WebSearchMode;
  private readonly defaultAdditionalDirectories: string[];
  private warnedAboutMaxTurns = false;

  constructor(options: CodexRunnerOptions = {}) {
    this.codexPath = options.codexPath;
    this.defaultSandbox = options.defaultSandbox ?? 'workspace-write';
    this.defaultNetworkAccess = options.defaultNetworkAccess ?? true;
    this.defaultWebSearchMode = options.defaultWebSearchMode ?? 'cached';
    this.defaultAdditionalDirectories = options.defaultAdditionalDirectories ?? [];
  }

  private createCodex(params: AgentRunParams): Codex {
    const env = buildAgentEnv(process.env, params);
    return new Codex({
      ...(this.codexPath ? { codexPathOverride: this.codexPath } : {}),
      env: stringEnv(env),
    });
  }

  private warnIfMaxTurnsIgnored(maxTurns: number | undefined): void {
    if (maxTurns === undefined || this.warnedAboutMaxTurns) return;
    this.warnedAboutMaxTurns = true;
    logger.warn(
      { maxTurns },
      'Codex SDK has no turn-limit option; enforcing only the configured wall-clock timeout',
    );
  }

  private threadOptions(params: AgentRunParams) {
    const synthesis = params.profile === 'synthesis';
    return {
      model: params.model,
      workingDirectory: params.workingDirectory ?? WORKSPACE_PATH,
      skipGitRepoCheck: true,
      modelReasoningEffort: params.effort as ModelReasoningEffort | undefined,
      sandboxMode: params.sandbox ?? (synthesis ? 'read-only' : this.defaultSandbox),
      networkAccessEnabled:
        params.networkAccess ?? (synthesis ? false : this.defaultNetworkAccess),
      webSearchMode: params.webSearchMode ?? (synthesis ? 'disabled' : this.defaultWebSearchMode),
      approvalPolicy: 'never' as const,
      additionalDirectories:
        params.additionalDirectories ?? (synthesis ? [] : this.defaultAdditionalDirectories),
    };
  }

  private input(params: AgentRunParams): Input {
    const instructions =
      params.profile === 'synthesis' || params.resumeSessionId
        ? ''
        : `<goldfish-delivery-instructions>\n${slackSystemPrompt(params.nativeMarkdown)}\n</goldfish-delivery-instructions>\n\n`;
    const text = `${instructions}${params.prompt}`;
    if (!params.imagePaths?.length) return text;
    return [
      { type: 'text', text },
      ...params.imagePaths.map((path) => ({ type: 'local_image' as const, path })),
    ];
  }

  async run(params: AgentRunParams): Promise<Result<AgentResponse>> {
    this.warnIfMaxTurnsIgnored(params.maxTurns);
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const abort = combineAbort(params.signal, timeoutMs);
    const startedAt = Date.now();

    try {
      const codex = this.createCodex(params);
      const thread = params.resumeSessionId
        ? codex.resumeThread(params.resumeSessionId, this.threadOptions(params))
        : codex.startThread(this.threadOptions(params));
      const turn = await thread.run(this.input(params), { signal: abort.signal });
      const sessionId = thread.id;
      if (!sessionId) {
        return err(createError(ErrorCodes.CODEX_PROTOCOL_ERROR, 'Codex completed without a thread ID'));
      }

      return ok({
        backend: 'codex',
        result: turn.finalResponse,
        sessionId,
        model: params.model,
        durationMs: Date.now() - startedAt,
        usage: turn.usage
          ? {
              inputTokens: turn.usage.input_tokens,
              cachedInputTokens: turn.usage.cached_input_tokens,
              outputTokens: turn.usage.output_tokens,
              reasoningOutputTokens: turn.usage.reasoning_output_tokens,
            }
          : undefined,
      });
    } catch (error) {
      const timedOut = abort.didTimeout();
      logger.error({ error, timedOut }, 'Codex SDK run failed');
      return err(
        createError(
          timedOut ? ErrorCodes.CODEX_TIMEOUT : ErrorCodes.CODEX_SPAWN_FAILED,
          timedOut ? `Codex timed out after ${timeoutMs}ms` : 'Codex run failed',
          error,
        ),
      );
    } finally {
      abort.cleanup();
    }
  }

  async *runStream(
    params: AgentRunParams,
  ): AsyncGenerator<StreamEvent, AgentResponse | undefined> {
    this.warnIfMaxTurnsIgnored(params.maxTurns);
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const abort = combineAbort(params.signal, timeoutMs);
    const startedAt = Date.now();
    let sessionId = params.resumeSessionId ?? '';
    let finalText = '';
    let usage: AgentResponse['usage'];

    try {
      const codex = this.createCodex(params);
      const thread = params.resumeSessionId
        ? codex.resumeThread(params.resumeSessionId, this.threadOptions(params))
        : codex.startThread(this.threadOptions(params));
      const streamed = await thread.runStreamed(this.input(params), { signal: abort.signal });

      for await (const event of streamed.events) {
        if (event.type === 'thread.started') {
          sessionId = event.thread_id;
          continue;
        }
        if (event.type === 'turn.failed') throw new Error(event.error.message);
        if (event.type === 'error') throw new Error(event.message);

        if (event.type === 'item.started') {
          const name = toolName(event.item);
          if (name) yield { type: 'tool_start', toolName: name, toolId: event.item.id };
          continue;
        }

        if (event.type === 'item.completed') {
          if (event.item.type === 'agent_message') {
            finalText = event.item.text;
          } else if (event.item.type === 'error') {
            yield { type: 'error', message: event.item.message };
          } else {
            const name = toolName(event.item);
            if (name) {
              const output = toolOutput(event.item);
              yield { type: 'tool_result', toolId: event.item.id, toolName: name, toolInput: toolInput(event.item), ...output };
              yield { type: 'tool_end', toolId: event.item.id };
            }
          }
          continue;
        }

        if (event.type === 'turn.completed') {
          usage = {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
            reasoningOutputTokens: event.usage.reasoning_output_tokens,
          };
        }
      }

      sessionId = thread.id ?? sessionId;
      if (!sessionId) throw new Error('Codex completed without a thread ID');
      const durationMs = Date.now() - startedAt;
      if (finalText) yield { type: 'text_delta', text: finalText };
      yield { type: 'result', result: finalText, sessionId, durationMs, usage };
      return {
        backend: 'codex',
        result: finalText,
        sessionId,
        model: params.model,
        durationMs,
        usage,
      };
    } catch (error) {
      const timedOut = abort.didTimeout();
      throw new Error(
        timedOut ? `Codex timed out after ${timeoutMs}ms` : `Codex run failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      abort.cleanup();
    }
  }

  async checkAvailable(): Promise<Result<string>> {
    return new Promise((resolve) => {
      let command: string;
      let prefixArgs: string[];
      try {
        command = this.codexPath ?? process.execPath;
        prefixArgs = this.codexPath ? [] : [bundledCodexEntry()];
      } catch (error) {
        resolve(err(createError(
          ErrorCodes.CODEX_SPAWN_FAILED,
          'Bundled Codex CLI could not be resolved',
          error,
        )));
        return;
      }
      const proc = spawn(command, [...prefixArgs, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) {
          resolve(err(createError(ErrorCodes.CODEX_SPAWN_FAILED, `Codex CLI not available (exit code ${code}): ${stderr.trim()}`)));
          return;
        }

        const auth = spawn(command, [...prefixArgs, 'login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let authOutput = '';
        auth.stdout.on('data', (data) => { authOutput += data.toString(); });
        auth.stderr.on('data', (data) => { authOutput += data.toString(); });
        auth.on('close', (authCode) => {
          if (authCode === 0) resolve(ok(`${stdout.trim()} (${authOutput.trim()})`));
          else resolve(err(createError(ErrorCodes.CODEX_SPAWN_FAILED, `Codex CLI is installed but not authenticated: ${authOutput.trim()}`)));
        });
        auth.on('error', (error) => {
          resolve(err(createError(ErrorCodes.CODEX_SPAWN_FAILED, 'Could not check Codex authentication', error)));
        });
      });
      proc.on('error', (error) => {
        resolve(err(createError(ErrorCodes.CODEX_SPAWN_FAILED, 'Codex CLI not found in PATH', error)));
      });
    });
  }
}
