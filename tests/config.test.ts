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
