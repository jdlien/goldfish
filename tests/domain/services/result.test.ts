import { describe, it, expect } from 'vitest';
import { ok, err, createError, ErrorCodes } from '../../../src/domain/services/result.js';

describe('ok', () => {
  it('wraps a value as a successful result', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('works with undefined for void results', () => {
    const result = ok(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});

describe('err', () => {
  it('wraps an error as a failed result', () => {
    const error = createError('TEST', 'Something failed');
    const result = err(error);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TEST');
      expect(result.error.message).toBe('Something failed');
    }
  });
});

describe('createError', () => {
  it('creates an AppError with code and message', () => {
    const error = createError('BOOM', 'It broke');
    expect(error.code).toBe('BOOM');
    expect(error.message).toBe('It broke');
    expect(error.cause).toBeUndefined();
  });

  it('includes cause when provided', () => {
    const cause = new Error('root cause');
    const error = createError('BOOM', 'It broke', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('ErrorCodes', () => {
  it('contains expected error codes', () => {
    expect(ErrorCodes.SLACK_CONNECTION_FAILED).toBe('SLACK_CONNECTION_FAILED');
    expect(ErrorCodes.CLAUDE_SPAWN_FAILED).toBe('CLAUDE_SPAWN_FAILED');
    expect(ErrorCodes.DATABASE_ERROR).toBe('DATABASE_ERROR');
    expect(ErrorCodes.CLAUDE_TIMEOUT).toBe('CLAUDE_TIMEOUT');
  });
});
