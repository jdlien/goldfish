/**
 * `goldfish search` — query the memory index (FTS / vector / hybrid).
 *
 *   goldfish search "deploy deadline"
 *   goldfish search "what did I decide about leaving TPL" --mode hybrid --k 10
 *   goldfish search "exact tokens" --mode fts
 *   goldfish search "conceptual question" --mode vector
 *   goldfish search "query" --json        # stable JSON for tools/agents
 *   goldfish search "query" --explain     # show fts rank / vector distance
 *   goldfish search 'foo AND bar' --raw   # pass raw FTS5 syntax
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { searchMemory, type SearchMode, type SearchResult } from '../lib/memorySearch.js';

const MODES: SearchMode[] = ['hybrid', 'fts', 'vector'];

export function formatText(result: SearchResult, explain: boolean): string {
  const lines: string[] = [];
  lines.push(
    chalk.dim(
      `${result.hits.length} result${result.hits.length === 1 ? '' : 's'} · mode: ${result.mode}` +
        (result.vectorsAvailable ? '' : ' · vectors unavailable'),
    ),
  );
  if (result.hits.length === 0) {
    lines.push(chalk.dim('  (no matches)'));
    return lines.join('\n');
  }
  for (const h of result.hits) {
    const loc = `${h.path}:${h.startLine}-${h.endLine}`;
    const evidence = h.sources.join('+');
    let meta = `${chalk.dim('[' + evidence + ']')} ${chalk.dim('score ' + h.score.toFixed(4))}`;
    if (explain) {
      const bits: string[] = [];
      if (h.ftsRank !== undefined) bits.push(`fts#${h.ftsRank}`);
      if (h.vectorDistance !== undefined) bits.push(`dist ${h.vectorDistance.toFixed(4)}`);
      if (bits.length) meta += chalk.dim(` (${bits.join(', ')})`);
    }
    lines.push(`${chalk.cyan(loc)}  ${meta}`);
    lines.push(`  ${h.snippet.replace(/\n+/g, ' ')}`);
  }
  return lines.join('\n');
}

export function formatJson(result: SearchResult): string {
  return JSON.stringify(
    {
      query: result.query,
      mode: result.mode,
      vectorsAvailable: result.vectorsAvailable,
      count: result.hits.length,
      results: result.hits.map((h) => ({
        path: h.path,
        startLine: h.startLine,
        endLine: h.endLine,
        chunkId: h.chunkId,
        score: h.score,
        sources: h.sources,
        snippet: h.snippet,
        ...(h.ftsRank !== undefined ? { ftsRank: h.ftsRank } : {}),
        ...(h.vectorDistance !== undefined ? { vectorDistance: h.vectorDistance } : {}),
      })),
    },
    null,
    2,
  );
}

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Search the memory index (FTS, vector, or hybrid)')
    .option('-m, --mode <mode>', `search mode: ${MODES.join(' | ')} (default: hybrid if vectors exist)`)
    .option('-k, --k <n>', 'number of results', (v) => parseInt(v, 10), 10)
    .option('-d, --db <path>', 'database path (defaults to GOLDFISH_SEARCH_DB)')
    .option('--json', 'output stable JSON')
    .option('--explain', 'show fts rank / vector distance')
    .option('--raw', 'treat the query as raw FTS5 syntax (no escaping)')
    .action(async (query: string, options) => {
      const { SEARCH_DB_PATH } = await import('../config.js');
      const { createEmbedderFromConfig } = await import('../lib/embedder.js');

      const mode = options.mode as SearchMode | undefined;
      if (mode && !MODES.includes(mode)) {
        console.error(`Invalid --mode "${mode}". Use one of: ${MODES.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      // FTS-only never needs the model; otherwise resolve the embedder.
      const embedder = mode === 'fts' ? null : await createEmbedderFromConfig();

      try {
        const result = await searchMemory({
          dbPath: options.db || SEARCH_DB_PATH,
          query,
          mode,
          k: options.k,
          embedder,
          rawFts: options.raw,
        });
        console.log(options.json ? formatJson(result) : formatText(result, !!options.explain));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });
}
