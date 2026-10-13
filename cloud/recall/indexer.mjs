// indexer.mjs — drain acmi:t-{tenant}:outbox into the Qdrant recall index.
//
// Per outbox item {ref, kind, ts}:
//   1. load the canonical entry from Redis (loadEntry; Redis is the truth)
//   2. gone from Redis -> delete its points (the index follows the canon)
//   3. redact secret-shaped strings, chunk (~800 chars, 100 overlap), embed
//   4. upsert points with deterministic ids, then delete stale chunks of the
//      same ref (an entry that shrank leaves no orphans)
//   5. on failure: retry with exponential backoff; after maxAttempts the item
//      goes to acmi:t-{tenant}:outbox:dlq with an error code (never a message)
//
// Nothing here logs entry text, payloads, vectors or error messages. The
// optional `log` gets counts, codes and a sha256 prefix of the ref.

import { createHash } from "node:crypto";
import { redact, hasSecret } from "./redact.mjs";
import { chunkText } from "./chunk.mjs";
import { loadEntry as defaultLoadEntry, canonicalPatterns, logRef, isDeniedKey, lmTwinRef, MAX_TEXT } from "./refs.mjs";
import { checkTenant, outboxKey, dlqKey, retryKey, refInTenant, enqueue, MAX_REF } from "./outbox.mjs";

export const COLLECTION = "acmi_memory_v1";
export const INDEX_VERSION = 1;
export const DLQ_MAX = 10_000;
// Hard bound on raw text handed to redact(); entries are capped at 512 KB by the bridge.
export const RAW_MAX = 1024 * 1024;

/**
 * Redact first, then cap. Text over RAW_MAX is first cut back to a whitespace
 * boundary, so a secret straddling the cut is dropped whole, not left as a
 * fragment too short for its pattern.
 */
export function prepareText(text) {
  let s = String(text ?? "");
  if (s.length > RAW_MAX) {
    s = s.slice(0, RAW_MAX);
    const ws = Math.max(s.lastIndexOf(" "), s.lastIndexOf("\n"), s.lastIndexOf("\t"));
    s = ws > 0 ? s.slice(0, ws) : "";
  }
  const clean = redact(s);
  return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) : clean;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const refTag = (ref) => sha256(String(ref)).slice(0, 12);

/** Point id: the first 128 bits of sha256(tenant|ref|chunkIndex), formatted as a UUID (v8 layout). */
export function pointId(tenant, ref, chunkIndex) {
  const h = createHash("sha256").update(`${tenant}|${ref}|${chunkIndex}`).digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export const tenantFilter = (tenant) => ({ key: "tenant_id", match: { value: checkTenant(tenant) } });

// ensureCollection + payload indexes once per (client, collection).
const ensured = new WeakMap();
export async function ensureIndex({ qdrant, collection = COLLECTION, dim, force = false }) {
  let done = ensured.get(qdrant);
  if (!done) ensured.set(qdrant, (done = new Set()));
  if (done.has(collection) && !force) return;
  await qdrant.ensureCollection(collection, dim);
  // tenant_id is the filter on every search: without this index Qdrant scans.
  await qdrant.ensurePayloadIndex(collection, "tenant_id", { type: "keyword", is_tenant: true });
  await qdrant.ensurePayloadIndex(collection, "ref", "keyword");
  await qdrant.ensurePayloadIndex(collection, "kind", "keyword");
  await qdrant.ensurePayloadIndex(collection, "ts_ms", "integer");
  done.add(collection);
}

/** An error's code if it is a short snake_case word, else "index_failed". Never the message. */
export const errCode = (e) => (e && typeof e.code === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(e.code) ? e.code : "index_failed");

async function lpop(redis, key, n) {
  const out = await redis("LPOP", key, n);
  if (out == null) return [];
  return Array.isArray(out) ? out : [out];
}

/** Index one canonical entry now. Returns { chunks } or { removed: true }. */
export async function indexRef({ redis, qdrant, embed, tenant, ref, kind, collection = COLLECTION, loadEntry = defaultLoadEntry }) {
  const byRef = { must: [tenantFilter(tenant), { key: "ref", match: { value: ref } }] };
  // A legacy acmi: entry that was migrated to lm: is indexed once, under the lm: ref.
  if (ref.startsWith("acmi:") && (await lmTwinRef(redis, tenant, ref))) {
    await qdrant.delete(collection, byRef);
    return { removed: true, twin: true, chunks: 0 };
  }
  const loaded = await loadEntry(redis, tenant, ref);
  if (!loaded) {
    await qdrant.delete(collection, byRef);
    return { removed: true, chunks: 0 };
  }
  const clean = prepareText(loaded.text);
  const chunks = chunkText(clean);
  const vectors = await embed(chunks);
  if (!Array.isArray(vectors) || vectors.length !== chunks.length || vectors.some((v) => !Array.isArray(v) || v.length !== embed.dim)) {
    const e = new Error("embedder returned the wrong shape");
    e.code = "embed_shape";
    throw e;
  }
  const content_hash = sha256(clean);
  const ts_ms = Number.isFinite(loaded.ts_ms) ? loaded.ts_ms : 0;
  const k = String(loaded.kind ?? kind ?? "memo");
  const points = chunks.map((chunk, i) => ({
    id: pointId(tenant, ref, i),
    vector: vectors[i],
    payload: { tenant_id: tenant, ref, kind: k, ts_ms, chunk, chunk_index: i, index_version: INDEX_VERSION, content_hash },
  }));
  await qdrant.upsert(collection, points);
  // Chunks past the new count belong to an older, longer version of the entry.
  await qdrant.delete(collection, { must: [...byRef.must, { key: "chunk_index", range: { gte: chunks.length } }] });
  return { removed: false, chunks: chunks.length };
}

/**
 * Pop up to `batch` outbox items for one tenant and index them.
 * Returns { popped, indexed, chunks, removed, retried, deferred, dead }.
 */
export async function indexOnce({
  redis,
  qdrant,
  embed,
  tenant,
  collection = COLLECTION,
  batch = 50,
  loadEntry = defaultLoadEntry,
  maxAttempts = 5,
  backoffMs = 1000,
  dlqMax = DLQ_MAX,
  now = Date.now,
  log = () => {},
} = {}) {
  checkTenant(tenant);
  if (typeof embed !== "function" || !Number.isInteger(embed.dim)) throw new Error("indexOnce: embed must be a function with an integer dim");
  await ensureIndex({ qdrant, collection, dim: embed.dim });
  const stats = { popped: 0, indexed: 0, chunks: 0, removed: 0, retried: 0, deferred: 0, dead: 0 };
  const items = await lpop(redis, outboxKey(tenant), batch);
  stats.popped = items.length;

  const toDlq = async (item, attempts, code) => {
    await redis("RPUSH", dlqKey(tenant), JSON.stringify({ ...item, attempts, error: code, failed_at: now() }));
    await redis("LTRIM", dlqKey(tenant), -dlqMax, -1);
    stats.dead++;
    log({ event: "recall_dlq", tenant, ref: item.ref ? refTag(item.ref) : null, attempts, error: code });
  };

  for (const raw of items) {
    let item;
    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== "object" || Array.isArray(p) || typeof p.ref !== "string") throw new Error();
      // Same rules as enqueue(): the outbox is writable by anything with the tenant's
      // Redis access, so nothing popped is trusted. Bad kind/ts become null.
      const kind = typeof p.kind === "string" && p.kind.length <= 64 && !hasSecret(p.kind) ? p.kind : null;
      const ts = typeof p.ts === "number" && Number.isFinite(p.ts) ? p.ts : null;
      item = { ref: p.ref, kind, ts };
    } catch {
      await toDlq({ ref: null, kind: null, ts: null, raw_sha256: sha256(String(raw)).slice(0, 16) }, 0, "bad_item");
      continue;
    }
    if (item.ref.length > MAX_REF || hasSecret(item.ref) || !refInTenant(tenant, item.ref)) {
      await toDlq({ ref: null, kind: item.kind, ts: item.ts, ref_sha256: refTag(item.ref) }, 0, "bad_ref");
      continue;
    }
    const prev = JSON.parse((await redis("HGET", retryKey(tenant), item.ref)) || "null");
    if (prev && prev.next > now()) {
      await redis("RPUSH", outboxKey(tenant), JSON.stringify(item));
      stats.deferred++;
      continue;
    }
    try {
      const r = await indexRef({ redis, qdrant, embed, tenant, ref: item.ref, kind: item.kind, collection, loadEntry });
      if (r.removed) stats.removed++;
      else {
        stats.indexed++;
        stats.chunks += r.chunks;
      }
      if (prev) await redis("HDEL", retryKey(tenant), item.ref);
    } catch (e) {
      // A missing collection (volume lost, or deleted by hand): re-create it next run.
      if (e?.status === 404) ensured.get(qdrant)?.delete(collection);
      const code = errCode(e);
      const attempts = (prev?.n ?? 0) + 1;
      if (code === "bad_ref" || attempts >= maxAttempts) {
        await redis("HDEL", retryKey(tenant), item.ref);
        await toDlq(item, attempts, code);
      } else {
        const next = now() + backoffMs * 2 ** (attempts - 1);
        await redis("HSET", retryKey(tenant), item.ref, JSON.stringify({ n: attempts, next }));
        await redis("RPUSH", outboxKey(tenant), JSON.stringify(item));
        stats.retried++;
        log({ event: "recall_retry", tenant, ref: refTag(item.ref), attempts, error: code });
      }
    }
  }
  log({ event: "recall_index", tenant, ...stats });
  return stats;
}

async function scanKeys(redis, match) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis("SCAN", cursor, "MATCH", match, "COUNT", 500);
    keys.push(...(batch || []));
    cursor = String(next);
  } while (cursor !== "0");
  return [...new Set(keys)].sort();
}

/**
 * Rebuild one tenant's slice of the index from Redis: delete every point with
 * tenant_id == tenant, then enqueue every canonical entry. Run indexOnce (or
 * the indexer loop) afterwards to fill it back in.
 */
export async function rebuild({ redis, qdrant, embed, tenant, collection = COLLECTION, log = () => {} } = {}) {
  checkTenant(tenant);
  if (embed) await ensureIndex({ qdrant, collection, dim: embed.dim, force: true });
  await qdrant.delete(collection, { must: [tenantFilter(tenant)] });
  let enqueued = 0;
  for (const p of canonicalPatterns(tenant)) {
    for (const key of await scanKeys(redis, p.match)) {
      if (isDeniedKey(key)) continue;
      const type = String((await redis("TYPE", key)) || "none").toLowerCase();
      if (p.type === "log") {
        if (type !== "zset") continue;
        const flat = await redis("ZRANGE", key, 0, -1, "WITHSCORES");
        for (let i = 0; i < (flat || []).length; i += 2) {
          const ref = logRef(key, flat[i + 1], flat[i]);
          if (key.startsWith("acmi:") && (await lmTwinRef(redis, tenant, ref))) continue; // the lm: copy is indexed instead
          try {
            await enqueue(redis, tenant, { ref, kind: null, ts: Number(flat[i + 1]) });
            enqueued++;
          } catch {
            /* a ref that can't be queued (too long) is skipped, never logged */
          }
        }
      } else if (type === "string") {
        try {
          await enqueue(redis, tenant, { ref: key, kind: null, ts: Date.now() });
          enqueued++;
        } catch {
          /* skipped, as above */
        }
      }
    }
  }
  log({ event: "recall_rebuild", tenant, enqueued });
  return { deleted: true, enqueued };
}
