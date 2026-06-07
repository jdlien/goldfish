/**
 * Phase 0 spike — vector-search-restore plan.
 *
 * Throwaway de-risking script. Proves, before any indexer refactor:
 *   1. sqlite-vec loads into better-sqlite3, vec0 + KNN SQL shape works.
 *   2. node-llama-cpp loads the nomic GGUF and emits a 768-dim vector.
 *   3. The new runtime's vectors are cosine-comparable to the old OpenClaw
 *      embeddings (decides whether the old embedding_cache is reusable).
 *
 * Run: pnpm exec tsx scripts/spike-vectors.ts
 * Not part of the test suite. Delete after Phase 0 is recorded.
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { getLlama, resolveModelFile } from 'node-llama-cpp';
import { homedir } from 'os';
import { join } from 'path';

const MODEL_URI = 'hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q8_0.gguf';
const MODEL_DIR =
  process.env.GOLDFISH_EMBEDDING_MODEL_DIR ||
  join(homedir(), 'Library', 'Application Support', 'goldfish', 'models');
const OLD_DB = join(homedir(), 'goldfish-workspace', 'memory', 'openclaw-index.sqlite');

function f32ToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

let pass = true;
const gate = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) pass = false;
};

// ---- Gate 1: sqlite-vec ----
console.log('\n=== Gate 1: sqlite-vec + better-sqlite3 ===');
{
  const db = new Database(':memory:');
  sqliteVec.load(db);
  const version = db.prepare('select vec_version() as v').pluck().get() as string;
  gate('vec_version()', !!version, version);

  db.exec(
    'create virtual table vt using vec0(chunk_id integer primary key, embedding float[4] distance_metric=cosine)'
  );
  const ins = db.prepare('insert into vt(chunk_id, embedding) values (?, ?)');
  const rows: [number, Float32Array][] = [
    [1, new Float32Array([1, 0, 0, 0])],
    [2, new Float32Array([0, 1, 0, 0])],
    [3, new Float32Array([0.9, 0.1, 0, 0])],
  ];
  for (const [id, v] of rows) ins.run(BigInt(id), f32ToBlob(v)); // vec0 int PK must bind as BigInt

  const q = f32ToBlob(new Float32Array([1, 0, 0, 0]));
  const knn = db
    .prepare('select chunk_id, distance from vt where embedding match ? and k = ? order by distance')
    .all(q, 2) as { chunk_id: number; distance: number }[];
  gate(
    'KNN shape (match ? and k = ?)',
    knn.length === 2 && Number(knn[0].chunk_id) === 1,
    `nearest=${knn.map(r => Number(r.chunk_id)).join(',')}`
  );
  db.close();
}

// ---- Gate 2: node-llama-cpp embedding ----
console.log('\n=== Gate 2: node-llama-cpp embedding ===');
const modelPath = await resolveModelFile(MODEL_URI, MODEL_DIR);
gate('model resolved', !!modelPath, modelPath);
const llama = await getLlama();
const model = await llama.loadModel({ modelPath });
const ctx = await model.createEmbeddingContext();

const e1 = await ctx.getEmbeddingFor('search_document: The cat sat on the mat.');
const v1 = Float32Array.from(e1.vector);
gate('emits 768-dim vector', v1.length === 768, `dims=${v1.length}`);

// sanity: a near-paraphrase should be closer than an unrelated sentence
const ePara = Float32Array.from((await ctx.getEmbeddingFor('search_document: A feline rested upon the rug.')).vector);
const eUnrel = Float32Array.from((await ctx.getEmbeddingFor('search_document: Quarterly tax filing deadlines in Alberta.')).vector);
const simPara = cosine(v1, ePara);
const simUnrel = cosine(v1, eUnrel);
gate('semantic ordering (paraphrase > unrelated)', simPara > simUnrel, `para=${simPara.toFixed(3)} unrel=${simUnrel.toFixed(3)}`);

// ---- Gate 3: cosine vs old OpenClaw vectors ----
console.log('\n=== Gate 3: compatibility with old OpenClaw embeddings ===');
{
  const old = new Database(OLD_DB, { readonly: true });
  // old chunks: text + embedding (JSON array). Grab a few non-trivial ones.
  const samples = old
    .prepare("select text, embedding from chunks where length(text) between 200 and 1200 limit 3")
    .all() as { text: string; embedding: string }[];
  old.close();

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const oldVec = JSON.parse(s.embedding) as number[];
    const newVec = Float32Array.from((await ctx.getEmbeddingFor('search_document: ' + s.text)).vector);
    const sim = cosine(newVec, oldVec);
    gate(`sample ${i + 1} cosine vs old (dims old=${oldVec.length})`, sim > 0.95, `cos=${sim.toFixed(4)}`);
  }

  // Diagnostic: which prefix convention did the OLD indexer use? And are vecs normalized?
  const s = samples[0];
  const oldVec = JSON.parse(s.embedding) as number[];
  const oldNorm = Math.sqrt(oldVec.reduce((a, x) => a + x * x, 0));
  const withDoc = Float32Array.from((await ctx.getEmbeddingFor('search_document: ' + s.text)).vector);
  const withQuery = Float32Array.from((await ctx.getEmbeddingFor('search_query: ' + s.text)).vector);
  const noPrefix = Float32Array.from((await ctx.getEmbeddingFor(s.text)).vector);
  const newNorm = Math.sqrt(Array.from(withDoc).reduce((a, x) => a + x * x, 0));
  console.log(`  diag: old‖v‖=${oldNorm.toFixed(3)} new‖v‖=${newNorm.toFixed(3)}`);
  console.log(`  diag: cos(old, search_document:)=${cosine(withDoc, oldVec).toFixed(4)}`);
  console.log(`  diag: cos(old, search_query:)   =${cosine(withQuery, oldVec).toFixed(4)}`);
  console.log(`  diag: cos(old, no-prefix)       =${cosine(noPrefix, oldVec).toFixed(4)}`);
}

await ctx.dispose();
await model.dispose();

console.log(`\n${pass ? '✅ ALL GATES PASSED' : '❌ ONE OR MORE GATES FAILED'}`);
process.exit(pass ? 0 : 1);
