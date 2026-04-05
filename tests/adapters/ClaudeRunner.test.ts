import { describe, it, expect } from 'vitest';
import { ClaudeRunner } from '../../src/adapters/ClaudeRunner.js';
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
