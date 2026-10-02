import type { Result } from '../domain/services/result.js';
import type { StreamEvent } from './StreamEventParser.js';

export type AgentBackend = 'claude' | 'codex';
export type AgentWebSearchMode = 'disabled' | 'cached' | 'live';

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
}

export interface AgentResponse {
  backend: AgentBackend;
  result: string;
  sessionId: string;
  model?: string;
  usage?: AgentUsage;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export interface AgentRunParams {
  prompt: string;
  resumeSessionId?: string;
  maxTurns?: number;
  timeoutMs?: number;
  model?: string;
  effort?: string;
  nativeMarkdown?: boolean;
  slackChannelId?: string;
  slackThreadTs?: string;
  imagePaths?: string[];
  signal?: AbortSignal;
  profile?: 'interactive' | 'synthesis';
  workingDirectory?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  networkAccess?: boolean;
  webSearchMode?: AgentWebSearchMode;
  additionalDirectories?: string[];
}

export interface AgentCapabilities {
  textDeltas: boolean;
  toolEvents: boolean;
  imageInputs: boolean;
}

export interface AgentRunner {
  readonly backend: AgentBackend;
  readonly capabilities: AgentCapabilities;
  run(params: AgentRunParams): Promise<Result<AgentResponse>>;
  runStream(
    params: AgentRunParams,
  ): AsyncGenerator<StreamEvent, AgentResponse | undefined>;
  checkAvailable(): Promise<Result<string>>;
}

/**
 * Build a private child environment without leaking a previous Slack target.
 * The daemon posts the normal reply, but agent-invoked `goldfish send` and
 * `goldfish upload` inherit these destination variables. Missing values delete
 * inherited keys so a stale process environment cannot misdirect a message.
 */
export function buildAgentEnv(
  base: NodeJS.ProcessEnv,
  params: Pick<AgentRunParams, 'slackChannelId' | 'slackThreadTs'> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    NO_COLOR: '1',
    GOLDFISH_SESSION: '1',
  };

  if (params.slackChannelId) env.GOLDFISH_CHANNEL_ID = params.slackChannelId;
  else delete env.GOLDFISH_CHANNEL_ID;

  if (params.slackThreadTs) env.GOLDFISH_THREAD_TS = params.slackThreadTs;
  else delete env.GOLDFISH_THREAD_TS;

  return env;
}

export function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
