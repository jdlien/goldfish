import { describe, it, expect } from 'vitest';
import { isHumanMessage } from '../../src/lib/messageFilter.js';

describe('isHumanMessage', () => {
  it('accepts an ordinary message', () => {
    expect(isHumanMessage(undefined)).toBe(true);
  });

  it('accepts a message with an attachment', () => {
    expect(isHumanMessage('file_share')).toBe(true);
  });

  // Regression: a user ticked "also send to channel" and the message — a
  // substantive one — was dropped with no error and had to be
  // relayed by hand.
  it('accepts a thread reply sent with "also send to channel"', () => {
    expect(isHumanMessage('thread_broadcast')).toBe(true);
  });

  it('ignores edits, deletions, joins, and bot posts', () => {
    for (const subtype of [
      'message_changed',
      'message_deleted',
      'message_replied',
      'channel_join',
      'channel_leave',
      'channel_topic',
      'channel_purpose',
      'channel_name',
      'bot_message',
    ]) {
      expect(isHumanMessage(subtype)).toBe(false);
    }
  });

  it('ignores an unknown future subtype rather than guessing', () => {
    expect(isHumanMessage('some_subtype_slack_adds_in_2027')).toBe(false);
  });
});
