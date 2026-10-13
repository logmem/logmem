// search.mjs — tenant-filtered recall and the POST /v1/recall handler.
//
// The tenant filter is built here, from the tenant the server authenticated,
// and is the first `must` clause of every search. Callers can narrow by kinds
// and since; they cannot pass a filter, a tenant or a collection over HTTP.
// Every hit is hydrated from Redis (the truth): a ref that no longer loads is
// dropped, and so is any hit whose payload names another tenant.

import { checkTenant, refInTenant, RecallError } from "./outbox.mjs";
import { loadEntry as defaultLoadEntry } from "./refs.mjs";
import { normTs } from "../../src/core/store.mjs";
import { COLLECTION, tenantFilter, errCode } from "./indexer.mjs";

export const MAX_LIMIT = 50;
export const MAX_QUERY = 2000;
export const MAX_KINDS = 20;
export const MAX_BODY = 64 * 1024;

const bad = (msg) => new RecallError("bad_request", msg);

function parseSince(since) {
  if (since == null || since === "") return null;
  if (typeof since === "number" && Number.isFinite(since)) return normTs(since);
  if (typeof since === "string") {
    if (/^\d+$/.test(since)) return normTs(Number(since));
    const t = Date.parse(since);
    if (Number.isFinite(t)) return t;
  }
  throw bad("since must be epoch ms or an ISO date");
}

export function validateQuery({ query, limit = 10, kinds, since } = {}) {
  if (typeof query !== "string" || !query.trim() || query.length > MAX_QUERY) throw bad(`query must be a non-empty string up to ${MAX_QUERY} characters`);
  const lim = Number(limit);
  if (!Number.isInteger(lim) || lim < 1 || lim > MAX_LIMIT) throw bad(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  let ks = null;
  if (kinds != null) {
    if (!Array.isArray(kinds) || kinds.length > MAX_KINDS || kinds.some((k) => typeof k !== "string" || !k || k.length > 64)) {
      throw bad(`kinds must be an array of up to ${MAX_KINDS} short strings`);
    }
    if (kinds.length) ks = [...new Set(kinds)];
  }
  return { query, limit: lim, kinds: ks, sinceMs: parseSince(since) };
}

/** Build the search filter. The tenant clause is always first and always present. */
export function buildFilter(tenant, { kinds, sinceMs } = {}) {
  const must = [tenantFilter(tenant)];
  if (kinds?.length) must.push({ key: "kind", match: { any: kinds } });
  if (sinceMs != null) must.push({ key: "ts_ms", range: { gte: sinceMs } });
  return { must };
}

/**
 * Recall for one tenant. Extra arguments (filter, tenant_id, …) are ignored:
 * only `tenant` (from auth) decides whose points are searched.
 */
export async function recall({ redis, qdrant, embed, tenant, query, limit = 10, kinds, since, collection = COLLECTION, loadEntry = defaultLoadEntry }) {
  checkTenant(tenant);
  const q = validateQuery({ query, limit, kinds, since });
  const [vector] = await embed([q.query]);
  // Several chunks of one entry can hit; over-fetch, then keep the best per ref.
  let hits;
  try {
    hits = await qdrant.search(collection, vector, { filter: buildFilter(tenant, q), limit: Math.min(q.limit * 3, 150) });
  } catch (e) {
    // No collection yet (fresh deployment, or the volume was lost and not rebuilt): nothing indexed, nothing to recall.
    if (e?.status === 404) return [];
    throw e;
  }
  const best = new Map();
  for (const h of hits) {
    const p = h.payload || {};
    if (p.tenant_id !== tenant || !refInTenant(tenant, p.ref)) continue; // defence in depth
    const cur = best.get(p.ref);
    if (!cur || h.score > cur.score) best.set(p.ref, { ref: p.ref, score: h.score, content_hash: p.content_hash });
  }
  // Highest score first; on a tie the canonical lm: copy beats a legacy acmi: twin.
  const lmFirst = (r) => (r.startsWith("lm:") ? 0 : 1);
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || lmFirst(a.ref) - lmFirst(b.ref));
  const out = [];
  const seen = new Set();
  for (const h of ranked) {
    if (out.length >= q.limit) break;
    let loaded = null;
    try {
      loaded = await loadEntry(redis, tenant, h.ref);
    } catch {
      loaded = null;
    }
    if (!loaded) continue; // deleted or missing in Redis: Redis wins
    // One result per entry: an entry copied to both acmi: and lm: has two refs.
    const e = loaded.entry && typeof loaded.entry === "object" ? loaded.entry : {};
    const id = e.trail ?? e.correlationId;
    const dedupe = typeof id === "string" && id ? `id|${id}|${loaded.ts_ms}` : `hash|${h.content_hash ?? h.ref}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ ref: h.ref, kind: loaded.kind, ts: loaded.ts_ms, score: h.score, entry: loaded.entry });
  }
  return out;
}

function bearer(headers = {}) {
  const raw = headers.authorization ?? headers.Authorization ?? (typeof headers.get === "function" ? headers.get("authorization") : null);
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(raw ?? ""));
  return m ? m[1] : null;
}

function parseBody(body) {
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  const s = Buffer.isBuffer(body) ? body.toString("utf8") : typeof body === "string" ? body : "";
  if (!s || s.length > MAX_BODY) throw bad("body must be a JSON object");
  let v;
  try {
    v = JSON.parse(s);
  } catch {
    throw bad("body must be a JSON object");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("body must be a JSON object");
  return v;
}

async function readStream(req) {
  if (req.body !== undefined) return req.body;
  if (typeof req.on !== "function") return undefined;
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(bad("body too large"));
        req.destroy?.();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", () => reject(bad("body unreadable")));
  });
}

const json = (status, body) => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body });

/**
 * POST /v1/recall {query, limit, kinds, since}
 *   Authorization: Bearer <ACMI key>  ->  verifyKey(redis, token) -> {tenant} | null
 * After a successful recall: meter(redis, tenant, "recall", 1).
 * Errors are generic codes; nothing from the request is echoed back.
 */
export function createRecallHandler({ redis, qdrant, embed, verifyKey, meter, collection = COLLECTION, loadEntry = defaultLoadEntry, log = () => {} }) {
  if (typeof verifyKey !== "function") throw new Error("createRecallHandler: verifyKey is required");
  if (typeof meter !== "function") throw new Error("createRecallHandler: meter is required");

  async function handle({ method, headers, body } = {}) {
    if (String(method || "").toUpperCase() !== "POST") return json(405, { error: "method_not_allowed" });
    const token = bearer(headers);
    if (!token) return json(401, { error: "unauthorized" });
    let tenant;
    try {
      const who = await verifyKey(redis, token);
      tenant = who && typeof who === "object" ? who.tenant : null;
      checkTenant(tenant);
    } catch {
      return json(401, { error: "unauthorized" });
    }
    let q;
    try {
      const b = parseBody(body);
      // Only these four fields are read. A caller's filter / tenant / tenant_id / collection is ignored.
      q = validateQuery({ query: b.query, limit: b.limit ?? 10, kinds: b.kinds, since: b.since });
    } catch (e) {
      return json(400, { error: "bad_request", detail: e?.code === "bad_request" ? e.message : undefined });
    }
    let results;
    try {
      results = await recall({ redis, qdrant, embed, tenant, query: q.query, limit: q.limit, kinds: q.kinds, since: q.sinceMs, collection, loadEntry });
      await meter(redis, tenant, "recall", 1);
    } catch (e) {
      log({ event: "recall_error", tenant, error: errCode(e) });
      return json(500, { error: "internal_error" });
    }
    return json(200, { results });
  }

  async function handler(req, res) {
    let out;
    try {
      const body = await readStream(req);
      out = await handle({ method: req.method, headers: req.headers, body });
    } catch {
      out = json(400, { error: "bad_request" });
    }
    res.statusCode = out.status;
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.end(JSON.stringify(out.body));
  }
  handler.handle = handle;
  return handler;
}
