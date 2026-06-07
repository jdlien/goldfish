/**
 * Real-model smoke test for the embedder. Opt-in, NOT part of `pnpm test`
 * (it loads the 139 MB GGUF). Run manually:
 *
 *   pnpm exec tsx scripts/smoke-embeddings.ts
 *
 * Verifies the real NodeLlamaCppEmbedder: model resolves, emits 768-dim
 * unit-length vectors, applies prefixes, and ranks a paraphrase above an
 * unrelated sentence.
 */
import { resolveModelFile } from 'node-llama-cpp';
import { NodeLlamaCppEmbedder } from '../src/lib/embedder.js';
import { EMBEDDING_MODEL_URI, EMBEDDING_MODEL_DIR, EMBEDDING_DIMS } from '../src/config.js';

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]; // both unit-length → dot == cosine
  return dot;
}

const modelPath = await resolveModelFile(EMBEDDING_MODEL_URI, EMBEDDING_MODEL_DIR);
console.log('model:', modelPath);

const embedder = new NodeLlamaCppEmbedder({
  modelPath,
  modelUri: EMBEDDING_MODEL_URI,
  dims: EMBEDDING_DIMS,
});

const [base, para, unrel] = await embedder.embed(
  ['The cat sat on the mat.', 'A feline rested upon the rug.', 'Quarterly tax filing deadlines in Alberta.'],
  'document',
);
const [query] = await embedder.embed(['where did the cat sit'], 'query');

let ok = true;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok = ok && cond;
};

check('768 dims', base.length === 768, `dims=${base.length}`);
let n = 0;
for (const x of base) n += x * x;
check('unit length', Math.abs(Math.sqrt(n) - 1) < 1e-4, `‖v‖=${Math.sqrt(n).toFixed(5)}`);
const simPara = cosine(base, para);
const simUnrel = cosine(base, unrel);
check('paraphrase > unrelated', simPara > simUnrel, `para=${simPara.toFixed(3)} unrel=${simUnrel.toFixed(3)}`);
check('query embeds (768)', query.length === 768);
console.log('providerKey:', embedder.providerKey);

await embedder.dispose();
console.log(ok ? '\n✅ SMOKE PASSED' : '\n❌ SMOKE FAILED');
process.exit(ok ? 0 : 1);
