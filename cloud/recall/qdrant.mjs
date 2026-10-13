// qdrant.mjs — the slice of Qdrant's REST API the recall index uses, over
// plain fetch, plus an in-memory double with the same surface for tests.
//
//   ensureCollection(name, dim)          GET /collections/{name}, PUT on 404
//   ensurePayloadIndex(name, field, s)   PUT /collections/{name}/index
//   upsert(name, points)                 PUT /collections/{name}/points?wait=true
//   search(name, vector, {filter,limit}) POST /collections/{name}/points/search
//   delete(name, filter)                 POST /collections/{name}/points/delete?wait=true
//
// Errors carry the op and HTTP status only. Never the api key, never the URL's
// credentials, never the response body (it can echo payload text).

import { RecallError } from "./outbox.mjs";

const NAME_RE = /^[A-Za-z0-9_-]{1,255}$/;
const FIELD_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function checkName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new RecallError("bad_collection", "invalid collection name");
  return name;
}

class QdrantError extends RecallError {
  constructor(op, status) {
    super("qdrant_error", `qdrant ${op} failed${status ? ` (HTTP ${status})` : ""}`);
    this.op = op;
    this.status = status ?? null;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const isLoopback = (host) => LOOPBACK.has(host) || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host);

/**
 * With an api key, the URL must be https:// (the key travels in a header).
 * Plain http:// is allowed with a key only for loopback hosts, or when the
 * caller passes insecureHttp: true for a private network it controls (e.g.
 * the compose network between the indexer and Qdrant on one VM).
 */
export function createQdrant({ url, apiKey, fetch = globalThis.fetch, timeoutMs = 10_000, insecureHttp = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new RecallError("bad_config", "qdrant url must be http(s)");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new RecallError("bad_config", "qdrant url must be http(s)");
  if (apiKey && parsed.protocol === "http:" && !isLoopback(parsed.hostname) && insecureHttp !== true) {
    throw new RecallError("bad_config", "qdrant url must be https when an api key is set");
  }
  if (typeof fetch !== "function") throw new RecallError("bad_config", "fetch is not available");
  const base = url.replace(/\/+$/, "");
  const headers = { "content-type": "application/json" };
  if (apiKey) headers["api-key"] = apiKey;

  async function call(op, method, path, body, { allow404 = false } = {}) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch {
      throw new QdrantError(op, null);
    }
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new QdrantError(op, res.status);
    try {
      return await res.json();
    } catch {
      throw new QdrantError(op, res.status);
    }
  }

  const col = (name) => `/collections/${encodeURIComponent(checkName(name))}`;

  return {
    kind: "qdrant",
    async ensureCollection(name, dim) {
      if (!Number.isInteger(dim) || dim < 1 || dim > 65536) throw new RecallError("bad_dim", "invalid vector size");
      const got = await call("get_collection", "GET", col(name), undefined, { allow404: true });
      if (got) {
        const size = got?.result?.config?.params?.vectors?.size;
        if (size != null && size !== dim) throw new RecallError("dim_mismatch", "collection vector size does not match the embedder");
        return { created: false };
      }
      await call("create_collection", "PUT", col(name), { vectors: { size: dim, distance: "Cosine" } });
      return { created: true };
    },
    /** Idempotent in Qdrant. `schema` defaults to keyword; tenant_id uses {type:"keyword", is_tenant:true}. */
    async ensurePayloadIndex(name, field, schema = "keyword") {
      if (typeof field !== "string" || !FIELD_RE.test(field)) throw new RecallError("bad_field", "invalid payload field");
      await call("create_index", "PUT", `${col(name)}/index?wait=true`, { field_name: field, field_schema: schema });
      return { ok: true };
    },
    async upsert(name, points) {
      if (!Array.isArray(points) || !points.length) return { upserted: 0 };
      await call("upsert", "PUT", `${col(name)}/points?wait=true`, {
        points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })),
      });
      return { upserted: points.length };
    },
    async search(name, vector, { filter, limit = 10 } = {}) {
      const body = { vector, limit, with_payload: true, with_vector: false };
      if (filter) body.filter = filter;
      const out = await call("search", "POST", `${col(name)}/points/search`, body);
      return (out?.result || []).map((h) => ({ id: h.id, score: h.score, payload: h.payload || {} }));
    },
    async delete(name, filter) {
      if (!filter || typeof filter !== "object") throw new RecallError("bad_filter", "delete needs a filter");
      await call("delete", "POST", `${col(name)}/points/delete?wait=true`, { filter });
      return { ok: true };
    },
  };
}

// ─── In-memory double ─────────────────────────────────────────────────────
// Same API. Filters: must / must_not / should, with conditions
// {key, match:{value}}, {key, match:{any:[...]}}, {key, range:{gt,gte,lt,lte}}.
// Anything else throws, so a new filter shape fails loudly in tests.

function condOk(payload, c) {
  if (!c || typeof c !== "object" || typeof c.key !== "string") throw new Error("memory-qdrant: unsupported condition");
  const v = payload[c.key];
  if (c.match) {
    if ("value" in c.match) return v === c.match.value;
    if (Array.isArray(c.match.any)) return c.match.any.includes(v);
    throw new Error("memory-qdrant: unsupported match");
  }
  if (c.range) {
    if (typeof v !== "number") return false;
    const r = c.range;
    return (r.gt == null || v > r.gt) && (r.gte == null || v >= r.gte) && (r.lt == null || v < r.lt) && (r.lte == null || v <= r.lte);
  }
  throw new Error("memory-qdrant: unsupported condition");
}

export function filterMatches(payload, filter) {
  if (!filter) return true;
  const known = new Set(["must", "must_not", "should"]);
  for (const k of Object.keys(filter)) if (!known.has(k)) throw new Error(`memory-qdrant: unsupported filter clause ${k}`);
  const must = filter.must || [];
  const not = filter.must_not || [];
  const should = filter.should || [];
  if (!must.every((c) => condOk(payload, c))) return false;
  if (not.some((c) => condOk(payload, c))) return false;
  if (should.length && !should.some((c) => condOk(payload, c))) return false;
  return true;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function createMemoryQdrant() {
  const collections = new Map(); // name -> { dim, points: Map(id -> {vector, payload}), indexes: Map(field -> schema) }
  const calls = [];
  const need = (name) => {
    const c = collections.get(checkName(name));
    if (!c) throw new QdrantError("missing_collection", 404);
    return c;
  };
  return {
    kind: "memory-qdrant",
    calls,
    collections,
    /** Test helper: every point in a collection, payloads copied. */
    points(name) {
      const c = collections.get(name);
      return c ? [...c.points.entries()].map(([id, p]) => ({ id, vector: [...p.vector], payload: { ...p.payload } })) : [];
    },
    /** Test helper: drop everything, as if the Qdrant volume were lost. */
    wipe() {
      collections.clear();
    },
    async ensureCollection(name, dim) {
      calls.push(["ensureCollection", name, dim]);
      const c = collections.get(checkName(name));
      if (c) {
        if (c.dim !== dim) throw new RecallError("dim_mismatch", "collection vector size does not match the embedder");
        return { created: false };
      }
      collections.set(name, { dim, points: new Map(), indexes: new Map() });
      return { created: true };
    },
    async ensurePayloadIndex(name, field, schema = "keyword") {
      calls.push(["ensurePayloadIndex", name, field]);
      need(name).indexes.set(field, schema);
      return { ok: true };
    },
    async upsert(name, points) {
      calls.push(["upsert", name, points.length]);
      const c = need(name);
      for (const p of points) {
        if (!Array.isArray(p.vector) || p.vector.length !== c.dim) throw new QdrantError("upsert", 400);
        c.points.set(String(p.id), { vector: [...p.vector], payload: structuredClone(p.payload || {}) });
      }
      return { upserted: points.length };
    },
    async search(name, vector, { filter, limit = 10 } = {}) {
      calls.push(["search", name, structuredClone(filter ?? null), limit]);
      const c = need(name);
      return [...c.points.entries()]
        .filter(([, p]) => filterMatches(p.payload, filter))
        .map(([id, p]) => ({ id, score: cosine(vector, p.vector), payload: structuredClone(p.payload) }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
        .slice(0, limit);
    },
    async delete(name, filter) {
      calls.push(["delete", name, structuredClone(filter)]);
      if (!filter || typeof filter !== "object") throw new RecallError("bad_filter", "delete needs a filter");
      const c = collections.get(checkName(name));
      if (!c) return { ok: true };
      for (const [id, p] of c.points) if (filterMatches(p.payload, filter)) c.points.delete(id);
      return { ok: true };
    },
  };
}
