/**
 * Where an agent-initiated Slack post should land.
 *
 * The agent's *own* replies are posted by the daemon, which knows the channel
 * and thread. Anything the agent posts itself — `goldfish send`, `goldfish
 * upload` — went through a separate path that knew neither, and the context
 * block handed to the agent never carried the thread ts. So the one argument
 * `--thread` needs was the one fact the agent could not obtain, and files
 * silently landed at channel top level while the conversation continued in a
 * thread. (2026-09-20: an audio clip broke out of the thread it was requested
 * in, and the threaded reply then pointed at it as being "above".)
 *
 * The fix is polarity, not documentation: `start.ts` exports the destination
 * into the agent's environment and these commands inherit it, so staying in
 * the conversation is the default and leaving it requires `--no-thread`.
 */

export interface DestinationFlags {
  /** `--channel`. */
  channel?: string;
  /** `--thread`. */
  thread?: string;
  /** `--no-thread`: post at channel top level, ignoring the inherited thread. */
  noThread?: boolean;
}

export interface ResolvedDestination {
  channel: string;
  threadTs?: string;
  /** True when the value came from the environment rather than a flag. */
  channelInherited: boolean;
  threadInherited: boolean;
}

export type DestinationResult =
  | { ok: true; value: ResolvedDestination }
  | { ok: false; error: string };

export const CHANNEL_ENV = 'GOLDFISH_CHANNEL_ID';
export const THREAD_ENV = 'GOLDFISH_THREAD_TS';

/**
 * Resolve flags against the session environment.
 *
 * Precedence, both axes: explicit flag → environment → nothing.
 *
 * `--thread` and `--no-thread` together is contradictory rather than
 * resolvable, so it errors instead of silently picking a winner.
 */
export function resolveDestination(
  flags: DestinationFlags,
  env: NodeJS.ProcessEnv = process.env,
): DestinationResult {
  if (flags.thread && flags.noThread) {
    return {
      ok: false,
      error: '--thread and --no-thread cannot be used together.',
    };
  }

  const envChannel = env[CHANNEL_ENV]?.trim() || undefined;
  const envThread = env[THREAD_ENV]?.trim() || undefined;

  const channel = flags.channel ?? envChannel;
  if (!channel) {
    return {
      ok: false,
      error:
        `No channel. Pass --channel, or run inside a Goldfish session ` +
        `(which sets ${CHANNEL_ENV}).`,
    };
  }

  // An explicitly named channel that differs from the session's own channel is
  // a deliberate cross-post, so an inherited thread ts — which belongs to the
  // other channel — must not ride along. A thread ts is only meaningful in the
  // channel it came from; reusing it elsewhere posts to an unrelated thread or
  // errors at the API.
  const crossChannel = Boolean(flags.channel && envChannel && flags.channel !== envChannel);

  let threadTs: string | undefined;
  let threadInherited = false;
  if (flags.thread) {
    threadTs = flags.thread;
  } else if (!flags.noThread && !crossChannel) {
    threadTs = envThread;
    threadInherited = Boolean(envThread);
  }

  return {
    ok: true,
    value: {
      channel,
      threadTs,
      channelInherited: !flags.channel && Boolean(envChannel),
      threadInherited,
    },
  };
}

/**
 * One line naming where a post actually went, and whether that was inherited.
 *
 * Printed by both commands so a misfire is visible in the session transcript
 * rather than only in Slack, where the agent cannot see it.
 */
export function describeDestination(d: ResolvedDestination): string {
  const channel = `${d.channel}${d.channelInherited ? ' (session)' : ''}`;
  const thread = d.threadTs
    ? `thread ${d.threadTs}${d.threadInherited ? ' (session)' : ''}`
    : 'channel top level';
  return `${channel} — ${thread}`;
}
