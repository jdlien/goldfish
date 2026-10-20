import { describe, it, expect } from 'vitest';
import {
  isPlaceholderText,
  renderRichTextBlocks,
  resolveMessageText,
  type SlackBlock,
} from '../../src/lib/richText.js';

const PLACEHOLDER = 'This message contains interactive elements.';

// Shape of the real payload from 2026-10-20: an Apple order email pasted into
// Slack. `text` came through as the placeholder; the order lived only here.
// Order details are made up.
const pastedOrderEmail: SlackBlock[] = [
  {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'Exciting news:\n\n' },
          { type: 'text', text: 'Details of your order.', style: { bold: true } },
          { type: 'text', text: '\nOrder Number: W0000000000\n' },
          { type: 'link', url: 'https://example.com/invoice', text: 'View invoice' },
          { type: 'text', text: '\n' },
        ],
      },
      {
        type: 'rich_text_list',
        style: 'bullet',
        indent: 0,
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '' }] }],
      },
      {
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'Mac Studio ' },
          { type: 'text', text: 'Arrives Tue Oct 27', style: { bold: true } },
          { type: 'text', text: '\n\nTracking number:\n1Z0000000000000000' },
        ],
      },
    ],
  },
];

describe('isPlaceholderText', () => {
  it('treats Slack\'s fallback string and empty text as placeholders', () => {
    expect(isPlaceholderText(PLACEHOLDER)).toBe(true);
    expect(isPlaceholderText('')).toBe(true);
    expect(isPlaceholderText(undefined)).toBe(true);
  });

  it('treats anything a person typed as real', () => {
    expect(isPlaceholderText('hi Rach')).toBe(false);
  });
});

describe('renderRichTextBlocks', () => {
  it('recovers a pasted email, dropping the empty bullet', () => {
    const out = renderRichTextBlocks(pastedOrderEmail);
    expect(out).toContain('Order Number: W0000000000');
    expect(out).toContain('<https://example.com/invoice|View invoice>');
    expect(out).toContain('Arrives Tue Oct 27');
    expect(out).toContain('1Z0000000000000000');
    expect(out).not.toContain('•');
  });

  it('renders mentions, emoji, lists, code and quotes', () => {
    const out = renderRichTextBlocks([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'user', user_id: 'U123' },
              { type: 'text', text: ' see ' },
              { type: 'channel', channel_id: 'C456' },
              { type: 'text', text: ' ' },
              { type: 'emoji', name: 'tada', unicode: '1f389' },
              { type: 'text', text: '\n' },
            ],
          },
          {
            type: 'rich_text_list',
            style: 'ordered',
            elements: [
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'one' }] },
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'two' }] },
            ],
          },
          { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'ls -la' }] },
          { type: 'rich_text_quote', elements: [{ type: 'text', text: 'quoted' }] },
        ],
      },
    ]);
    expect(out).toBe('<@U123> see <#C456> :tada:\n1. one\n2. two\n```\nls -la\n```\n> quoted');
  });

  it('ignores non-rich_text blocks', () => {
    expect(renderRichTextBlocks([{ type: 'section' }])).toBe('');
    expect(renderRichTextBlocks(undefined)).toBe('');
  });
});

describe('resolveMessageText', () => {
  // Regression: the agent received only the placeholder string (2026-10-20).
  it('replaces the placeholder with the content of the blocks', () => {
    const out = resolveMessageText(PLACEHOLDER, pastedOrderEmail);
    expect(out).not.toContain(PLACEHOLDER);
    expect(out).toContain('Arrives Tue Oct 27');
  });

  it('keeps Slack\'s own text when it is real', () => {
    expect(resolveMessageText('hello <@U1>', pastedOrderEmail)).toBe('hello <@U1>');
  });

  it('falls back to the placeholder when the blocks are empty too', () => {
    expect(resolveMessageText(PLACEHOLDER, [])).toBe(PLACEHOLDER);
  });
});
