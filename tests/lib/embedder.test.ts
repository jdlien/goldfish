import { describe, it, expect } from 'vitest';
import {
  applyPrefix,
  l2normalize,
  FakeEmbedder,
  type Embedder,
} from '../../src/lib/embedder.js';

function norm(v: Float32Array): number {
  let n = 0;
  for (const x of v) n += x * x;
  return Math.sqrt(n);
}

describe('applyPrefix', () => {
  it('applies the nomic task prefixes (trailing space significant)', () => {
    expect(applyPrefix('hello', 'document')).toBe('search_document: hello');
    expect(applyPrefix('hello', 'query')).toBe('search_query: hello');
  });
});

describe('l2normalize', () => {
  it('produces a unit vector', () => {
    const v = l2normalize(Float32Array.from([3, 4]));
    expect(norm(v)).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });

  it('leaves a zero vector untouched (no divide-by-zero)', () => {
    const v = l2normalize(Float32Array.from([0, 0, 0]));
    expect(Array.from(v)).toEqual([0, 0, 0]);
  });
});

describe('FakeEmbedder', () => {
  it('returns the configured dimensionality (default 768)', async () => {
    const e: Embedder = new FakeEmbedder();
    const [v] = await e.embed(['anything'], 'document');
    expect(v.length).toBe(768);
  });

  it('is deterministic — same (text, kind) yields the same vector', async () => {
    const e = new FakeEmbedder();
    const [a] = await e.embed(['the cat'], 'document');
    const [b] = await e.embed(['the cat'], 'document');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('outputs unit-length vectors', async () => {
    const e = new FakeEmbedder();
    const [v] = await e.embed(['some memory text'], 'document');
    expect(norm(v)).toBeCloseTo(1, 5);
  });

  it('document and query of the same text differ (prefix is part of the seed)', async () => {
    const e = new FakeEmbedder();
    const [doc] = await e.embed(['same text'], 'document');
    const [qry] = await e.embed(['same text'], 'query');
    expect(Array.from(doc)).not.toEqual(Array.from(qry));
  });

  it('records the prefixed text it embedded (proves prefixing happens)', async () => {
    const e = new FakeEmbedder();
    await e.embed(['alpha', 'beta'], 'document');
    await e.embed(['gamma'], 'query');
    expect(e.seen).toEqual([
      'search_document: alpha',
      'search_document: beta',
      'search_query: gamma',
    ]);
  });

  it('embeds a batch in order', async () => {
    const e = new FakeEmbedder();
    const vecs = await e.embed(['one', 'two', 'three'], 'document');
    expect(vecs).toHaveLength(3);
    vecs.forEach((v) => expect(v.length).toBe(768));
  });

  it('exposes cache-key identity fields', () => {
    const e = new FakeEmbedder({ model: 'm1', providerKey: 'k1' });
    expect(e.provider).toBe('fake');
    expect(e.model).toBe('m1');
    expect(e.providerKey).toBe('k1');
  });
});
