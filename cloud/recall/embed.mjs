// embed.mjs — the embedder contract and a deterministic fake for tests.
//
// An embedder is `async (texts: string[]) => number[][]` with a `dim` property.
// No real provider is wired: Mikey picks one (open question 2 in BACKPLANE.md).
// A real one must be called with redacted text only; the indexer guarantees it.

import { createHash } from "node:crypto";

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/** Hashing-trick bag of words (unigrams + bigrams), L2-normalised. No network, fully deterministic. */
export function fakeEmbedder({ dim = 64 } = {}) {
  if (!Number.isInteger(dim) || dim < 2) throw new Error("fakeEmbedder: dim must be an integer >= 2");
  function one(text) {
    const v = new Array(dim).fill(0);
    const toks = String(text ?? "").toLowerCase().match(TOKEN_RE) || [];
    const feats = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]} ${t}`)];
    for (const f of feats) {
      const h = createHash("sha256").update(f).digest();
      const idx = h.readUInt32BE(0) % dim;
      v[idx] += h[4] & 1 ? 1 : -1;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (!n) {
      v[0] = 1; // empty text: a fixed unit vector, never NaN
      return v;
    }
    return v.map((x) => x / n);
  }
  const embed = async (texts) => texts.map(one);
  embed.dim = dim;
  embed.model = `fake-hash-${dim}`;
  return embed;
}
