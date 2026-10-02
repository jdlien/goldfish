import { readFileSync } from 'fs';
import { AgentRunnerRegistry } from '../adapters/AgentRunnerFactory.js';
import type { AgentBackend } from '../adapters/AgentRunner.js';
import { runtimeForChannel } from '../config.js';
import { logger } from '../lib/logger.js';

export interface AgentRunCommandOptions {
  backend?: AgentBackend;
  model?: string;
  effort?: string;
  cwd?: string;
  timeoutMs?: number;
  maxTurns?: number;
}

/** Internal provider-neutral entry point used by isolated synthesis scripts. */
export async function agentRunCommand(options: AgentRunCommandOptions): Promise<void> {
  const prompt = readFileSync(0, 'utf8');
  const runtime = runtimeForChannel(undefined, options);
  const previousLogLevel = logger.level;
  logger.level = 'silent';
  try {
    const result = await new AgentRunnerRegistry().get(runtime.backend).run({
      prompt,
      model: runtime.model,
      effort: runtime.effort,
      timeoutMs: options.timeoutMs,
      maxTurns: options.maxTurns,
      profile: 'synthesis',
      workingDirectory: options.cwd ?? process.cwd(),
      sandbox: 'read-only',
      networkAccess: false,
      webSearchMode: 'disabled',
    });
    if (!result.ok) throw new Error(result.error.message, { cause: result.error.cause });
    // This command's stdout is a machine-readable data channel. Synthesis
    // scripts persist it verbatim, so diagnostics must never share it.
    process.stdout.write(result.value.result);
  } finally {
    logger.level = previousLogLevel;
  }
}
