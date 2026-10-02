import {
  CODEX_NETWORK,
  CODEX_PATH,
  CODEX_SANDBOX,
  CODEX_WEB_SEARCH,
  CODEX_ADDITIONAL_DIRECTORIES,
  CLAUDE_PATH,
} from '../config.js';
import type { AgentBackend, AgentRunner } from './AgentRunner.js';
import { ClaudeRunner } from './ClaudeRunner.js';
import { CodexRunner } from './CodexRunner.js';

export class AgentRunnerRegistry {
  private readonly runners: Record<AgentBackend, AgentRunner>;

  constructor(runners?: Partial<Record<AgentBackend, AgentRunner>>) {
    this.runners = {
      claude: runners?.claude ?? new ClaudeRunner(CLAUDE_PATH),
      codex:
        runners?.codex ??
        new CodexRunner({
          codexPath: CODEX_PATH,
          defaultSandbox: CODEX_SANDBOX,
          defaultNetworkAccess: CODEX_NETWORK,
          defaultWebSearchMode: CODEX_WEB_SEARCH,
          defaultAdditionalDirectories: CODEX_ADDITIONAL_DIRECTORIES,
        }),
    };
  }

  get(backend: AgentBackend): AgentRunner {
    return this.runners[backend];
  }
}
