import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * effortForChannel resolves per-channel thinking effort from env at import time,
 * so each case re-imports config with the desired env in place.
 */
async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  const saved = {
    GOLDFISH_EFFORT: process.env.GOLDFISH_EFFORT,
    GOLDFISH_EFFORT_BY_CHANNEL: process.env.GOLDFISH_EFFORT_BY_CHANNEL,
    GOLDFISH_MODEL: process.env.GOLDFISH_MODEL,
    GOLDFISH_MODEL_BY_CHANNEL: process.env.GOLDFISH_MODEL_BY_CHANNEL,
    GOLDFISH_BACKEND: process.env.GOLDFISH_BACKEND,
    GOLDFISH_BACKEND_BY_CHANNEL: process.env.GOLDFISH_BACKEND_BY_CHANNEL,
    GOLDFISH_CLAUDE_MODEL: process.env.GOLDFISH_CLAUDE_MODEL,
    GOLDFISH_CLAUDE_MODEL_BY_CHANNEL: process.env.GOLDFISH_CLAUDE_MODEL_BY_CHANNEL,
    GOLDFISH_CODEX_MODEL: process.env.GOLDFISH_CODEX_MODEL,
    GOLDFISH_CODEX_MODEL_BY_CHANNEL: process.env.GOLDFISH_CODEX_MODEL_BY_CHANNEL,
    GOLDFISH_CODEX_PATH: process.env.GOLDFISH_CODEX_PATH,
    GOLDFISH_CODEX_NETWORK: process.env.GOLDFISH_CODEX_NETWORK,
    GOLDFISH_CODEX_WEB_SEARCH: process.env.GOLDFISH_CODEX_WEB_SEARCH,
    GOLDFISH_CODEX_ADDITIONAL_DIRECTORIES: process.env.GOLDFISH_CODEX_ADDITIONAL_DIRECTORIES,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import('../src/config.js');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('effortForChannel', () => {
  afterEach(() => vi.resetModules());

  it('returns undefined when nothing is configured', async () => {
    const cfg = await loadConfig({
      GOLDFISH_EFFORT: undefined,
      GOLDFISH_EFFORT_BY_CHANNEL: undefined,
    });
    expect(cfg.effortForChannel('C123')).toBeUndefined();
    expect(cfg.effortForChannel(undefined)).toBeUndefined();
  });

  it('applies the global default when set', async () => {
    const cfg = await loadConfig({
      GOLDFISH_EFFORT: 'medium',
      GOLDFISH_EFFORT_BY_CHANNEL: undefined,
    });
    expect(cfg.effortForChannel('C123')).toBe('medium');
  });

  it('lets a per-channel override beat the default', async () => {
    const cfg = await loadConfig({
      GOLDFISH_EFFORT: 'high',
      GOLDFISH_EFFORT_BY_CHANNEL: JSON.stringify({ C0A7VB1U6EA: 'low' }),
    });
    expect(cfg.effortForChannel('C0A7VB1U6EA')).toBe('low');
    expect(cfg.effortForChannel('C_OTHER')).toBe('high');
  });

  it('degrades an invalid level to undefined (CLI default) rather than passing junk', async () => {
    const cfg = await loadConfig({
      GOLDFISH_EFFORT: 'turbo',
      GOLDFISH_EFFORT_BY_CHANNEL: JSON.stringify({ C0A7VB1U6EA: 'ludicrous' }),
    });
    expect(cfg.effortForChannel('C0A7VB1U6EA')).toBeUndefined();
    expect(cfg.effortForChannel('C_OTHER')).toBeUndefined();
  });

  it('survives malformed JSON in the channel map', async () => {
    const cfg = await loadConfig({
      GOLDFISH_EFFORT: undefined,
      GOLDFISH_EFFORT_BY_CHANNEL: '{not valid json',
    });
    expect(cfg.effortForChannel('C0A7VB1U6EA')).toBeUndefined();
  });

  it('accepts all five valid levels', async () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const cfg = await loadConfig({
        GOLDFISH_EFFORT: level,
        GOLDFISH_EFFORT_BY_CHANNEL: undefined,
      });
      expect(cfg.effortForChannel('C123')).toBe(level);
    }
  });
});

describe('runtimeForChannel', () => {
  afterEach(() => vi.resetModules());

  it('keeps Claude as the compatibility default', async () => {
    const cfg = await loadConfig({ GOLDFISH_BACKEND: undefined });
    expect(cfg.runtimeForChannel('C1').backend).toBe('claude');
  });

  it('routes a channel to Codex with only the Codex model map', async () => {
    const cfg = await loadConfig({
      GOLDFISH_BACKEND: 'claude',
      GOLDFISH_BACKEND_BY_CHANNEL: JSON.stringify({ C_CODEX: 'codex' }),
      GOLDFISH_CLAUDE_MODEL: 'sonnet',
      GOLDFISH_CODEX_MODEL: 'gpt-default',
      GOLDFISH_CODEX_MODEL_BY_CHANNEL: JSON.stringify({ C_CODEX: 'gpt-6-astra' }),
    });
    expect(cfg.runtimeForChannel('C_CODEX')).toMatchObject({
      backend: 'codex',
      model: 'gpt-6-astra',
    });
    expect(cfg.runtimeForChannel('C_OTHER')).toMatchObject({
      backend: 'claude',
      model: 'sonnet',
    });
  });

  it('does not pass Codex-only ultra effort to Claude', async () => {
    const cfg = await loadConfig({ GOLDFISH_EFFORT: 'ultra' });
    expect(cfg.runtimeForChannel('C1', { backend: 'claude' }).effort).toBeUndefined();
    expect(cfg.runtimeForChannel('C1', { backend: 'codex' }).effort).toBe('ultra');
  });

  it('keeps replies on an explicitly pinned proactive backend', async () => {
    const cfg = await loadConfig({ GOLDFISH_BACKEND: 'claude' });
    expect(cfg.runtimeForConversation('C1', {
      agentBackend: 'codex',
      agentBackendPinned: true,
    }).backend).toBe('codex');
    expect(cfg.runtimeForConversation('C1', {
      agentBackend: 'codex',
      agentBackendPinned: false,
    }).backend).toBe('claude');
  });
});

describe('Codex execution policy', () => {
  afterEach(() => vi.resetModules());

  it('uses the SDK CLI and Goldfish network defaults when unset', async () => {
    const cfg = await loadConfig({
      GOLDFISH_CODEX_PATH: undefined,
      GOLDFISH_CODEX_NETWORK: undefined,
      GOLDFISH_CODEX_WEB_SEARCH: undefined,
      GOLDFISH_CODEX_ADDITIONAL_DIRECTORIES: undefined,
    });
    expect(cfg.CODEX_PATH).toBeUndefined();
    expect(cfg.CODEX_NETWORK).toBe(true);
    expect(cfg.CODEX_WEB_SEARCH).toBe('cached');
    expect(cfg.CODEX_ADDITIONAL_DIRECTORIES).toEqual([]);
  });

  it('parses explicit network, search, and additional-directory controls', async () => {
    const cfg = await loadConfig({
      GOLDFISH_CODEX_PATH: '/custom/codex',
      GOLDFISH_CODEX_NETWORK: 'false',
      GOLDFISH_CODEX_WEB_SEARCH: 'live',
      GOLDFISH_CODEX_ADDITIONAL_DIRECTORIES: '/one:/two',
    });
    expect(cfg.CODEX_PATH).toBe('/custom/codex');
    expect(cfg.CODEX_NETWORK).toBe(false);
    expect(cfg.CODEX_WEB_SEARCH).toBe('live');
    expect(cfg.CODEX_ADDITIONAL_DIRECTORIES).toEqual(['/one', '/two']);
  });

  it('rejects a shared effort that is invalid for a channel backend', async () => {
    const cfg = await loadConfig({
      GOLDFISH_BACKEND: 'codex',
      GOLDFISH_BACKEND_BY_CHANNEL: JSON.stringify({ C_CLAUDE: 'claude' }),
      GOLDFISH_EFFORT: 'ultra',
      GOLDFISH_EFFORT_BY_CHANNEL: undefined,
    });
    expect(cfg.validateConfiguration()).toContain(
      'GOLDFISH_EFFORT "ultra" is not valid for claude channel C_CLAUDE.',
    );
  });
});

describe('modelForChannel', () => {
  afterEach(() => vi.resetModules());

  it('returns undefined when nothing is configured', async () => {
    const cfg = await loadConfig({
      GOLDFISH_MODEL: undefined,
      GOLDFISH_MODEL_BY_CHANNEL: undefined,
    });
    expect(cfg.modelForChannel('C123')).toBeUndefined();
    expect(cfg.modelForChannel(undefined)).toBeUndefined();
  });

  it('applies the global default when set', async () => {
    const cfg = await loadConfig({
      GOLDFISH_MODEL: 'sonnet',
      GOLDFISH_MODEL_BY_CHANNEL: undefined,
    });
    expect(cfg.modelForChannel('C123')).toBe('sonnet');
  });

  it('lets a per-channel override beat the default', async () => {
    const cfg = await loadConfig({
      GOLDFISH_MODEL: 'fable',
      GOLDFISH_MODEL_BY_CHANNEL: JSON.stringify({ C0A7VB1U6EA: 'haiku' }),
    });
    expect(cfg.modelForChannel('C0A7VB1U6EA')).toBe('haiku');
    expect(cfg.modelForChannel('C_OTHER')).toBe('fable');
  });

  it('passes full model IDs through unvalidated', async () => {
    const cfg = await loadConfig({
      GOLDFISH_MODEL: 'claude-sonnet-4-6',
      GOLDFISH_MODEL_BY_CHANNEL: undefined,
    });
    expect(cfg.modelForChannel('C123')).toBe('claude-sonnet-4-6');
  });

  it('survives malformed JSON in the channel map', async () => {
    const cfg = await loadConfig({
      GOLDFISH_MODEL: undefined,
      GOLDFISH_MODEL_BY_CHANNEL: '{not valid json',
    });
    expect(cfg.modelForChannel('C0A7VB1U6EA')).toBeUndefined();
  });
});
