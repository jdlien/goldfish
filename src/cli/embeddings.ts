/**
 * `goldfish embeddings` — manage the local semantic-search model.
 *
 *   goldfish embeddings setup     # download the GGUF (one-time, ~140 MB)
 *   goldfish embeddings status    # show model + index vector coverage
 *
 * The model lives outside the repo and workspace git (D6). Vector indexing/search
 * is additive: with no model, Goldfish stays FTS-only.
 */

import type { Command } from 'commander';
import chalk from 'chalk';

export function registerEmbeddingsCommand(program: Command): void {
  const embeddings = program
    .command('embeddings')
    .description('Manage the local embedding model for semantic memory search');

  embeddings
    .command('setup')
    .description('Download the embedding model (one-time)')
    .action(async () => {
      const { EMBEDDING_MODEL_URI, EMBEDDING_MODEL_DIR } = await import('../config.js');
      const { resolveModelFile } = await import('node-llama-cpp');
      console.log(`Resolving ${EMBEDDING_MODEL_URI}`);
      console.log(`into ${EMBEDDING_MODEL_DIR} …`);
      const path = await resolveModelFile(EMBEDDING_MODEL_URI, EMBEDDING_MODEL_DIR);
      console.log(chalk.green(`✓ Model ready: ${path}`));
      console.log('Run `goldfish index-memory` to build vectors, then `goldfish search`.');
    });

  embeddings
    .command('status')
    .description('Show model availability and index vector coverage')
    .action(async () => {
      const { EMBEDDING_MODEL_URI, EMBEDDING_DIMS, MEMORY_VECTORS_MODE, SEARCH_DB_PATH } =
        await import('../config.js');
      const { findLocalModel } = await import('../lib/embedder.js');

      console.log(chalk.bold('\nEmbedding model'));
      const model = findLocalModel();
      console.log(`  mode:   ${MEMORY_VECTORS_MODE}`);
      console.log(`  model:  ${EMBEDDING_MODEL_URI} (${EMBEDDING_DIMS}-dim)`);
      console.log(model ? chalk.green(`  status: installed — ${model}`)
                        : chalk.yellow('  status: NOT installed — run `goldfish embeddings setup`'));

      console.log(chalk.bold('\nIndex vector coverage'));
      const { existsSync } = await import('fs');
      if (!existsSync(SEARCH_DB_PATH)) {
        console.log(chalk.yellow(`  ${SEARCH_DB_PATH} does not exist yet — run \`goldfish index-memory\``));
      } else {
        const Database = (await import('better-sqlite3')).default;
        const sqliteVec = await import('sqlite-vec');
        const db = new Database(SEARCH_DB_PATH, { readonly: true });
        const chunks = (db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c;
        let vectors = 0;
        let hasVec = false;
        try {
          sqliteVec.load(db);
          if (db.prepare("SELECT name FROM sqlite_master WHERE name='chunks_vec'").get()) {
            hasVec = true;
            vectors = (db.prepare('SELECT chunk_id FROM chunks_vec').all() as unknown[]).length;
          }
        } catch {
          /* sqlite-vec unavailable — report FTS-only */
        }
        db.close();
        console.log(`  db:      ${SEARCH_DB_PATH}`);
        console.log(`  chunks:  ${chunks}`);
        console.log(
          hasVec
            ? `  vectors: ${vectors}${vectors === chunks ? chalk.green(' (full coverage)') : chalk.yellow(` (${chunks - vectors} missing — re-index to backfill)`)}`
            : chalk.yellow('  vectors: none yet (FTS-only) — run `goldfish index-memory` with the model installed'),
        );
      }
      console.log('');
    });
}
