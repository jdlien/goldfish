/**
 * Embedder — text → unit-length 768-dim vectors for semantic memory search.
 *
 * Phase 1 of the vector-search-restore plan. Wraps node-llama-cpp + the nomic
 * GGUF behind a narrow interface so the indexer and search command never touch
 * the model directly, and so tests can swap in a deterministic fake without
 * downloading or loading a real model.
 *
 * Phase-0 facts that shape this module (verified 2026-06-07):
 *  - nomic-embed-text-v1.5 REQUIRES task prefixes; OpenClaw omitted them (latent
 *    quality bug). We apply them here, in exactly one place. (D4)
 *  - node-llama-cpp returns UN-normalized vectors (‖v‖≈18.6). We L2-normalize so
 *    stored vectors are unit length and cosine == dot product. (D2)
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  EMBEDDING_MODEL_DIR,
  EMBEDDING_MODEL_URI,
  EMBEDDING_DIMS,
  MEMORY_VECTORS_MODE,
} from '../config.js';
import { createChildLogger } from './logger.js';

export type EmbeddingKind = 'document' | 'query';

/** nomic-embed-text-v1.5 task-instruction prefixes (trailing space is significant). */
const PREFIX: Record<EmbeddingKind, string> = {
  document: 'search_document: ',
  query: 'search_query: ',
};

export function applyPrefix(text: string, kind: EmbeddingKind): string {
  return PREFIX[kind] + text;
}

/** L2-normalize in place; returns the same array. Zero vectors are left as-is. */
export function l2normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] /= norm;
  }
  return v;
}

export interface Embedder {
  readonly dims: number;
  /** Runtime family, e.g. 'node-llama-cpp'. Part of the cache key. */
  readonly provider: string;
  /** Model identity (the HF URI). Part of the cache key. */
  readonly model: string;
  /** Stable per-weights identity (model file hash). Part of the cache key. */
  readonly providerKey: string;
  /** Embed a batch, applying the kind's prefix and L2-normalizing each vector. */
  embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]>;
}

export interface NodeLlamaCppEmbedderOptions {
  modelPath: string;
  modelUri: string;
  dims: number;
}

/**
 * Real embedder. Lazily loads the model + embedding context once per process.
 * node-llama-cpp is imported dynamically so importing this module (e.g. for the
 * fake) does not pull the native runtime into the unit-test path.
 */
export class NodeLlamaCppEmbedder implements Embedder {
  readonly dims: number;
  readonly provider = 'node-llama-cpp';
  readonly model: string;

  #modelPath: string;
  #providerKey: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #ctx: any | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #model: any | null = null;
  #loading: Promise<void> | null = null;

  constructor(opts: NodeLlamaCppEmbedderOptions) {
    this.#modelPath = opts.modelPath;
    this.model = opts.modelUri;
    this.dims = opts.dims;
  }

  /** sha256 of the GGUF file — changes iff the weights change. Computed once. */
  get providerKey(): string {
    if (this.#providerKey === null) {
      this.#providerKey = createHash('sha256')
        .update(readFileSync(this.#modelPath))
        .digest('hex')
        .slice(0, 32);
    }
    return this.#providerKey;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#ctx) return;
    if (!this.#loading) {
      this.#loading = (async () => {
        const { getLlama } = await import('node-llama-cpp');
        const llama = await getLlama();
        this.#model = await llama.loadModel({ modelPath: this.#modelPath });
        this.#ctx = await this.#model.createEmbeddingContext();
      })();
    }
    await this.#loading;
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    await this.#ensureLoaded();
    const out: Float32Array[] = [];
    for (const text of texts) {
      const res = await this.#ctx.getEmbeddingFor(applyPrefix(text, kind));
      const vec = Float32Array.from(res.vector as number[]);
      if (vec.length !== this.dims) {
        throw new Error(`Embedding dim mismatch: got ${vec.length}, expected ${this.dims}`);
      }
      out.push(l2normalize(vec));
    }
    return out;
  }

  async dispose(): Promise<void> {
    if (this.#ctx?.dispose) await this.#ctx.dispose();
    if (this.#model?.dispose) await this.#model.dispose();
    this.#ctx = null;
    this.#model = null;
    this.#loading = null;
  }
}

/**
 * Deterministic fake embedder for tests — no model, no I/O. Produces a stable,
 * L2-normalized vector seeded from the *prefixed* text, so:
 *  - the same (text, kind) always yields the same vector,
 *  - `document` vs `query` of the same text differ (prefix is included),
 *  - tests can inspect `.seen` to assert the prefix was actually applied.
 */
export class FakeEmbedder implements Embedder {
  readonly dims: number;
  readonly provider = 'fake';
  readonly model: string;
  readonly providerKey: string;
  /** Every prefixed string this embedder was asked to embed, in order. */
  readonly seen: string[] = [];

  constructor(opts: { dims?: number; model?: string; providerKey?: string } = {}) {
    this.dims = opts.dims ?? 768;
    this.model = opts.model ?? 'fake-model';
    this.providerKey = opts.providerKey ?? 'fake-key';
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    return texts.map((text) => {
      const prefixed = applyPrefix(text, kind);
      this.seen.push(prefixed);
      return l2normalize(this.#seededVector(prefixed));
    });
  }

  #seededVector(seed: string): Float32Array {
    // Hash-seeded LCG → deterministic pseudo-random unit vector.
    let state = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
    const v = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      v[i] = state / 0xffffffff - 0.5;
    }
    return v;
  }
}

/**
 * Find a local GGUF in the model dir WITHOUT downloading. Prefers a file whose
 * name matches the configured URI's basename, else the first `.gguf`.
 */
export function findLocalModel(dir: string = EMBEDDING_MODEL_DIR): string | null {
  if (!existsSync(dir)) return null;
  const ggufs = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.gguf'));
  if (ggufs.length === 0) return null;
  const wanted = EMBEDDING_MODEL_URI.split('/').pop()?.toLowerCase().replace('.gguf', '');
  const match = wanted ? ggufs.find((f) => f.toLowerCase().includes(wanted)) : undefined;
  return join(dir, match ?? ggufs[0]);
}

/**
 * Build the embedder the runtime should use, honoring MEMORY_VECTORS_MODE.
 * Never downloads silently (D6): the model must already be on disk (via
 * `goldfish embeddings setup`).
 *  - `off`      → null
 *  - `auto`     → embedder if the model is present, else warn + null (FTS-only)
 *  - `required` → embedder, or throw with a setup hint
 */
export async function createEmbedderFromConfig(): Promise<Embedder | null> {
  if (MEMORY_VECTORS_MODE === 'off') return null;
  const modelPath = findLocalModel();
  if (!modelPath) {
    const msg = `No embedding model in ${EMBEDDING_MODEL_DIR}. Run: goldfish embeddings setup`;
    if (MEMORY_VECTORS_MODE === 'required') throw new Error(msg);
    createChildLogger('embedder').warn(msg);
    return null;
  }
  return new NodeLlamaCppEmbedder({
    modelPath,
    modelUri: EMBEDDING_MODEL_URI,
    dims: EMBEDDING_DIMS,
  });
}
