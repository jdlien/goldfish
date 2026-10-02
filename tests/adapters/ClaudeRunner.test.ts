import { describe, it, expect } from 'vitest';
import {
  ClaudeRunner,
  SLACK_FORMATTING_LEGACY,
  SLACK_FORMATTING_NATIVE,
  slackSystemPrompt,
  buildAgentEnv,
} from '../../src/adapters/ClaudeRunner.js';
import { makeClaudeJsonOutput } from '../helpers/fixtures.js';

describe('ClaudeRunner.parseResponse', () => {
  it('parses valid JSON with standard field names', () => {
    const output = makeClaudeJsonOutput({
      result: 'Hello!',
      session_id: 'sess-123',
      cost_usd: 0.01,
      num_turns: 3,
    });
    const result = ClaudeRunner.parseResponse(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.result).toBe('Hello!');
      expect(result.value.sessionId).toBe('sess-123');
      expect(result.value.costUsd).toBe(0.01);
      expect(result.value.numTurns).toBe(3);
    }
  });

  it('parses fallback field names (response, sessionId)', () => {
    const output = JSON.stringify({
      response: 'Fallback response',
      sessionId: 'sess-456',
    });
    const result = ClaudeRunner.parseResponse(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.result).toBe('Fallback response');
      expect(result.value.sessionId).toBe('sess-456');
    }
  });

  it('handles missing sessionId gracefully', () => {
    const output = JSON.stringify({ result: 'No session' });
    const result = ClaudeRunner.parseResponse(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sessionId).toBe('');
    }
  });

  it('handles missing result field', () => {
    const output = JSON.stringify({ session_id: 'sess-789' });
    const result = ClaudeRunner.parseResponse(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.result).toBe('');
    }
  });

  it('handles costUsd via camelCase fallback', () => {
    const output = JSON.stringify({
      result: 'test',
      session_id: 'x',
      costUsd: 0.05,
      numTurns: 7,
    });
    const result = ClaudeRunner.parseResponse(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.costUsd).toBe(0.05);
      expect(result.value.numTurns).toBe(7);
    }
  });

  it('returns err for invalid JSON', () => {
    const result = ClaudeRunner.parseResponse('not json at all');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CLAUDE_PARSE_ERROR');
    }
  });

  it('returns err for empty string', () => {
    const result = ClaudeRunner.parseResponse('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CLAUDE_PARSE_ERROR');
    }
  });

  it('handles JSON with extra whitespace', () => {
    const output = `  \n  ${makeClaudeJsonOutput()}  \n  `;
    const result = ClaudeRunner.parseResponse(output);
    expect(result.ok).toBe(true);
  });
});

describe('Slack formatting guidance', () => {
  it('tells the legacy path that tables do not render', () => {
    // formatForSlack() flattens tables to bullet rows on this path, so the
    // model must not emit them.
    expect(SLACK_FORMATTING_LEGACY).toContain('NO TABLES');
    expect(SLACK_FORMATTING_LEGACY).not.toContain('TABLES RENDER NATIVELY');
  });

  it('tells the native path that tables render', () => {
    // chat.startStream renders markdown server-side.
    expect(SLACK_FORMATTING_NATIVE).toContain('TABLES RENDER NATIVELY');
    expect(SLACK_FORMATTING_NATIVE).not.toContain('NO TABLES');
  });

  it('defaults to the legacy prompt when the caller says nothing', () => {
    // The dangerous direction: promising tables on a path that flattens them
    // produces mush in briefings. Absent an explicit opt-in, assume legacy.
    expect(slackSystemPrompt(undefined)).toBe(SLACK_FORMATTING_LEGACY);
    expect(slackSystemPrompt(false)).toBe(SLACK_FORMATTING_LEGACY);
  });

  it('selects the native prompt only on explicit opt-in', () => {
    expect(slackSystemPrompt(true)).toBe(SLACK_FORMATTING_NATIVE);
  });
});


describe('buildAgentEnv', () => {
  const BASE = { PATH: '/usr/bin', HOME: '/Users/jdlien' } as NodeJS.ProcessEnv;

  it('keeps the existing session marker and base environment', () => {
    const env = buildAgentEnv(BASE, {});
    expect(env.GOLDFISH_SESSION).toBe('1');
    expect(env.NO_COLOR).toBe('1');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('exports the channel and thread the reply is going to', () => {
    const env = buildAgentEnv(BASE, {
      slackChannelId: 'C0TESTCHAN1',
      slackThreadTs: '1789695896.665579',
    });
    expect(env.GOLDFISH_CHANNEL_ID).toBe('C0TESTCHAN1');
    expect(env.GOLDFISH_THREAD_TS).toBe('1789695896.665579');
  });

  it('omits the thread key entirely rather than setting it empty', () => {
    // `upload` reads absence as "channel top level". An empty string would be
    // a value, and would have to be special-cased at every reader.
    const env = buildAgentEnv(BASE, { slackChannelId: 'C123' });
    expect('GOLDFISH_THREAD_TS' in env).toBe(false);
  });

  it('deletes a stale destination inherited from the daemon process', () => {
    // process.env is the base, so a leftover value would otherwise leak into
    // every session and misdirect posts that belong at channel top level.
    const stale = {
      ...BASE,
      GOLDFISH_CHANNEL_ID: 'C_OLD',
      GOLDFISH_THREAD_TS: '000.111',
    } as NodeJS.ProcessEnv;
    const env = buildAgentEnv(stale, { slackChannelId: 'C_NEW' });
    expect(env.GOLDFISH_CHANNEL_ID).toBe('C_NEW');
    expect('GOLDFISH_THREAD_TS' in env).toBe(false);
  });

  it('does not mutate the base environment', () => {
    const base = { ...BASE };
    buildAgentEnv(base, { slackChannelId: 'C123', slackThreadTs: '1.2' });
    expect('GOLDFISH_CHANNEL_ID' in base).toBe(false);
  });
});
