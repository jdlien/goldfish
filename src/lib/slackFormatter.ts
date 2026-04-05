/** Slack's message character limit (with margin for overhead) */
const SLACK_MSG_LIMIT = 3900;

/**
 * Split a message into chunks that fit within Slack's character limit.
 * Prefers splitting at paragraph breaks, then line breaks, then spaces.
 */
export function splitSlackMessage(text: string): string[] {
  if (text.length <= SLACK_MSG_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > SLACK_MSG_LIMIT) {
    const slice = remaining.slice(0, SLACK_MSG_LIMIT);
    // Priority: last double-newline, then last newline, then last space
    let splitAt = slice.lastIndexOf('\n\n');
    if (splitAt < SLACK_MSG_LIMIT * 0.3) splitAt = slice.lastIndexOf('\n');
    if (splitAt < SLACK_MSG_LIMIT * 0.3) splitAt = slice.lastIndexOf(' ');
    if (splitAt < SLACK_MSG_LIMIT * 0.3) splitAt = SLACK_MSG_LIMIT;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Convert standard Markdown to Slack's mrkdwn format
 *
 * Handles:
 * - **bold** → *bold*
 * - # Headers → *Header* (bold)
 * - [text](url) → <url|text>
 * - Tables → simplified list format
 */
export function formatForSlack(text: string): string {
  let result = text;

  // Convert **bold** to *bold* (must do before single asterisk handling)
  result = result.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // Convert markdown headers to bold text
  // ## Header → *Header*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Convert [text](url) links to <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert markdown tables to Slack-readable format
  result = convertTablesToLists(result);

  return result;
}

/**
 * Convert markdown tables to Slack-readable bullet lists.
 *
 * | Col1 | Col2 |
 * |------|------|
 * | A    | B    |
 *
 * Becomes:
 * *Col1* · *Col2*
 * A · B
 */
function convertTablesToLists(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let headers: string[] = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('|') && line.endsWith('|')) {
      // Skip separator rows (|---|---|)
      if (/^\|[\s\-:|]+\|$/.test(line)) {
        inTable = true;
        continue;
      }

      const cells = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());

      if (!inTable) {
        // Header row — render bold
        headers = cells;
        result.push(cells.map((h) => `*${h}*`).join('  ·  '));
        inTable = true;
      } else {
        // Data row
        result.push(cells.join('  ·  '));
      }
    } else {
      if (inTable) {
        inTable = false;
        headers = [];
      }
      result.push(lines[i]);
    }
  }

  return result.join('\n');
}
