/**
 * Recovering what a person actually sent when Slack's `text` field lies.
 *
 * Every Slack message carries a `text` field and, from modern clients, a
 * `rich_text` block holding the same content with structure. Usually they
 * agree. But when a paste is rich enough (here: an Apple order email with a
 * link and an empty bullet list), the client gives up on the plain-text
 * rendering and writes a fixed placeholder into `text` instead:
 *
 *   "This message contains interactive elements."
 *
 * The real content survives only in the blocks. Goldfish read `text`, so the
 * agent received the placeholder and nothing else (2026-10-20).
 *
 * We only override `text` when it is empty or that placeholder. In every other
 * case Slack's own rendering is kept, so ordinary messages are unchanged.
 */

const SLACK_FALLBACK_TEXT = 'This message contains interactive elements.';

interface RichTextElement {
  type: string;
  text?: string;
  url?: string;
  user_id?: string;
  channel_id?: string;
  usergroup_id?: string;
  range?: string;
  name?: string;
  unicode?: string;
  fallback?: string;
  style?: string | Record<string, unknown>;
  indent?: number;
  elements?: RichTextElement[];
}

export interface SlackBlock {
  type: string;
  elements?: RichTextElement[];
}

/** True when `text` carries no real content of its own. */
export function isPlaceholderText(text: string | undefined): boolean {
  const trimmed = (text ?? '').trim();
  return trimmed === '' || trimmed === SLACK_FALLBACK_TEXT;
}

/** Inline elements → text, in the same `<url|label>` shapes Slack uses in `text`. */
function renderInline(elements: RichTextElement[] = []): string {
  return elements
    .map((el) => {
      switch (el.type) {
        case 'text':
          return el.text ?? '';
        case 'link':
          return el.text ? `<${el.url}|${el.text}>` : `<${el.url}>`;
        case 'user':
          return `<@${el.user_id}>`;
        case 'channel':
          return `<#${el.channel_id}>`;
        case 'usergroup':
          return `<!subteam^${el.usergroup_id}>`;
        case 'broadcast':
          return `<!${el.range}>`;
        case 'emoji':
          return `:${el.name}:`;
        case 'date':
          return el.fallback ?? '';
        default:
          return el.text ?? '';
      }
    })
    .join('');
}

function renderList(list: RichTextElement): string {
  const indent = '  '.repeat(list.indent ?? 0);
  const ordered = list.style === 'ordered';
  return (list.elements ?? [])
    .map((item, i) => {
      const body = renderInline(item.elements);
      if (body.trim() === '') return null;
      return `${indent}${ordered ? `${i + 1}.` : '•'} ${body}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** Render every `rich_text` block in a message to plain text. */
export function renderRichTextBlocks(blocks: SlackBlock[] | undefined): string {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (block.type !== 'rich_text') continue;
    for (const el of block.elements ?? []) {
      switch (el.type) {
        case 'rich_text_section':
          parts.push(renderInline(el.elements));
          break;
        case 'rich_text_list': {
          const list = renderList(el);
          if (list) parts.push(`${list}\n`);
          break;
        }
        case 'rich_text_preformatted':
          parts.push('```\n' + renderInline(el.elements) + '\n```\n');
          break;
        case 'rich_text_quote':
          parts.push(
            renderInline(el.elements)
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n') + '\n',
          );
          break;
      }
    }
  }
  return parts.join('').trim();
}

/**
 * The text to hand the agent: Slack's `text`, unless it's empty or the
 * placeholder and the blocks hold something better.
 */
export function resolveMessageText(
  text: string | undefined,
  blocks: SlackBlock[] | undefined,
): string {
  if (!isPlaceholderText(text)) return text ?? '';
  const fromBlocks = renderRichTextBlocks(blocks);
  return fromBlocks || (text ?? '');
}
