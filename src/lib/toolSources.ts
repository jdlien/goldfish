/**
 * Extract source URLs from a tool's input/output so they can be shown
 * as native clickable sources in a Slack task_update timeline entry.
 *
 * Currently handles:
 * - WebFetch: single URL from the tool input
 * - WebSearch: URLs parsed from the tool output text
 * - Any other tool with a `url` field in its input (defensive)
 */

export type URLSource = {
  type: 'url';
  url: string;
  text: string;
};

const MAX_SOURCES = 10;
// Match http(s):// URLs up to the first whitespace or common delimiter
const URL_REGEX = /https?:\/\/[^\s)<>"'\]]+/g;

export function extractToolSources(
  toolName: string | undefined,
  toolInput: unknown,
  output: string,
): URLSource[] | undefined {
  if (!toolName) return undefined;

  // WebFetch: single URL lives in the input
  if (toolName === 'WebFetch') {
    const input = toolInput as { url?: string } | undefined;
    if (input?.url && typeof input.url === 'string') {
      return [toURLSource(input.url)];
    }
  }

  // WebSearch: URLs are in the result text
  if (toolName === 'WebSearch') {
    const urls = extractUrlsFromText(output);
    if (urls.length > 0) {
      return urls.slice(0, MAX_SOURCES).map(toURLSource);
    }
  }

  // Defensive: if any other tool has a url in its input, surface it
  if (
    toolInput &&
    typeof toolInput === 'object' &&
    'url' in toolInput &&
    typeof (toolInput as { url?: unknown }).url === 'string'
  ) {
    return [toURLSource((toolInput as { url: string }).url)];
  }

  return undefined;
}

function toURLSource(url: string): URLSource {
  return { type: 'url', url, text: url };
}

function extractUrlsFromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(URL_REGEX) ?? [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const match of matches) {
    // Strip trailing punctuation that the regex might have captured
    const clean = match.replace(/[.,;:!?]+$/, '');
    if (!seen.has(clean)) {
      seen.add(clean);
      unique.push(clean);
    }
  }
  return unique;
}
