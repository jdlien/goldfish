/**
 * Which Slack message subtypes represent a human typing something new.
 *
 * Slack overloads the `message` event: edits, deletions, joins, topic changes,
 * bot posts and real messages all arrive on it, distinguished by `subtype`. We
 * want exactly the ones a person composed and sent.
 *
 * This is an allowlist rather than a denylist on purpose — Slack adds subtypes
 * over time, and an unknown one silently reaching the agent is worse than an
 * unknown one being ignored. The cost is that a *missing* entry is invisible:
 * the message simply never arrives, with no error anywhere. That is exactly how
 * `thread_broadcast` was lost.
 */

/**
 * `undefined` — an ordinary message.
 * `file_share` — a message with an attachment; how Slack delivers files.
 * `thread_broadcast` — a thread reply with "also send to channel" ticked.
 *   Added 2026-09-17 after Don sent a substantive message with the box checked
 *   and got silence; JD had to copy it across by hand.
 *
 * Deliberately NOT included: `me_message` (`/me`) is also human-authored, but
 * nobody has produced one here and an untested entry in this list is the same
 * class of guess that a missing one is.
 */
const HUMAN_MESSAGE_SUBTYPES = new Set(['file_share', 'thread_broadcast']);

export function isHumanMessage(subtype: string | undefined): boolean {
  return subtype === undefined || HUMAN_MESSAGE_SUBTYPES.has(subtype);
}
