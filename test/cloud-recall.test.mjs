import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import { enqueue, outboxKey, dlqKey, retryKey } from "../cloud/recall/outbox.mjs";
import { redact, REDACTED } from "../cloud/recall/redact.mjs";
import { createQdrant, createMemoryQdrant, filterMatches } from "../cloud/recall/qdrant.mjs";
import { fakeEmbedder } from "../cloud/recall/embed.mjs";
import { chunkText } from "../cloud/recall/chunk.mjs";
import { loadEntry, logRef, parseRef } from "../cloud/recall/refs.mjs";
import { indexOnce, rebuild, pointId, COLLECTION } from "../cloud/recall/indexer.mjs";
import { recall, createRecallHandler } from "../cloud/recall/search.mjs";

// memory-redis has no LPOP; add it (with the optional count) over its data map.
function redisWithLists() {
  const base = createMemoryRedis();
  const r = async (cmd, ...args) => {
    const c = String(cmd).toUpperCase();
    if (c === "LPOP") {
      const e = base._data.get(String(args[0]));
      if (!e) return null;
      if (e.type !== "list") throw new Error("WRONGTYPE");
      const n = args[1] == null ? null : Number(args[1]);
      const out = e.value.splice(0, n ?? 1);
      if (!e.value.length) base._data.delete(String(args[0]));
      return n == null ? (out[0] ?? null) : out.length ? out : null;
    }
    if (c === "LLEN") return base._data.get(String(args[0]))?.value.length ?? 0;
    return base(cmd, ...args);
  };
  r._data = base._data;
  return r;
}

const embed = fakeEmbedder({ dim: 64 });
const noBackoff = { backoffMs: 0 };

async function setup() {
  const redis = redisWithLists();
  const qdrant = createMemoryQdrant();
  return { redis, qdrant, acme: createStore(redis, { space: "acme" }), beta: createStore(redis, { space: "beta" }) };
}

/** Append an entry and enqueue its ref, as the bridge would. */
async function write(redis, store, tenant, ns, id, entry) {
  const full = await store.append(ns, id, entry);
  const key = store.key(ns, id, "log");
  const flat = await redis("ZRANGEBYSCORE", key, full.ts, full.ts, "WITHSCORES");
  const member = flat.find((m, i) => i % 2 === 0 && JSON.parse(m).trail === full.trail);
  const ref = logRef(key, full.ts, member);
  await enqueue(redis, tenant, { ref, kind: full.kind, ts: full.ts });
  return { ref, entry: full };
}

async function drain(ctx, tenant, opts = {}) {
  const all = [];
  for (let i = 0; i < 20; i++) {
    const s = await indexOnce({ ...ctx, embed, tenant, ...noBackoff, ...opts });
    all.push(s);
    if (!s.popped) break;
  }
  return all;
}

// ─── redact ──────────────────────────────────────────────────────────────

test("redact: every secret shape from the scan is replaced", () => {
  const samples = [
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "sk-" + "proj-abcdefghijklmnopqrstuvwxyz012345",
    "sk-" + "ant-api03-abcdefghijklmnopqrstuv",
    "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "xoxb-" + "123456789012-abcdefghijkl",
    "sk_live_" + "abcdefghijklmnop1234",
    "AIza" + "SyA-abcdefghijklmnopqrstuvwxyz0123456",
    "glpat-" + "abcdefghijklmnopqrst",
    "acmi_live_" + "k1a2b3_" + "s3cr3tvalue1234567890",
  ];
  for (const s of samples) {
    const out = redact(`before ${s} after`);
    assert.ok(!out.includes(s), `leaked ${s.slice(0, 6)}`);
    assert.ok(out.includes(REDACTED));
    assert.match(out, /^before .*after$/);
  }
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow" + "IBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
  assert.equal(redact(`k: ${pem} ok`), `k: ${REDACTED} ok`);
  assert.equal(redact("postgres://admin:hunter2pass@db.internal:5432/x"), `postgres://${REDACTED}@db.internal:5432/x`);
  assert.equal(redact("Authorization: Bearer abc.def-ghi_jkl"), `Authorization: Bearer ${REDACTED}`);
  const hex = "a".repeat(20) + "0123456789abcdef0123";
  assert.equal(redact(`api_key=${hex}`), `api_key=${REDACTED}`);
  assert.equal(redact(`"token": "${"Zm9v".repeat(10)}"`), `"token": "${REDACTED}"`);
  assert.equal(redact(`secret=${"Q".repeat(40)}`), `secret=${REDACTED}`);
  // Ordinary text is left alone.
  const plain = "deploy the bridge at 10am; token budget is 32 items; see sk-learn docs";
  assert.equal(redact(plain), plain);
  assert.equal(redact(null), "");
});

// ─── outbox ──────────────────────────────────────────────────────────────

test("outbox: RPUSH carries {ref, kind, ts} only, and refuses refs outside the tenant", async () => {
  const redis = redisWithLists();
  await enqueue(redis, "acme", { ref: "lm:acme:channel:x:log@5#t1", kind: "memo", ts: 5, text: "SECRET", payload: { a: 1 } });
  const [raw] = await redis("LRANGE", outboxKey("acme"), 0, -1);
  assert.deepEqual(JSON.parse(raw), { ref: "lm:acme:channel:x:log@5#t1", kind: "memo", ts: 5 });
  await assert.rejects(enqueue(redis, "acme", { ref: "lm:beta:channel:x:log@5#t1" }), { code: "bad_ref" });
  await assert.rejects(enqueue(redis, "acme", { ref: "lm:acmex:channel:x:log@5#t1" }), { code: "bad_ref" });
  await assert.rejects(enqueue(redis, "Bad!", { ref: "lm:Bad!:x" }), { code: "bad_tenant" });
  await assert.rejects(enqueue(redis, "acme", { ref: "lm:acme:channel:" + "ghp_" + "a".repeat(36) + ":log@1#x" }), { code: "bad_ref" });
});

test("refs: parse log and doc refs; reject other namespaces and protected keys", () => {
  assert.deepEqual(parseRef("acme", "lm:acme:channel:ops:log@1791731538741#memoOps-1-ab"), { type: "log", key: "lm:acme:channel:ops:log", score: 1791731538741, id: "memoOps-1-ab" });
  assert.equal(parseRef("acme", "acmi:acme:thread:x:timeline@1700000000.5#cid").score, 1700000000.5);
  assert.deepEqual(parseRef("acme", "lm:acme:agent:quill:who"), { type: "doc", key: "lm:acme:agent:quill:who" });
  for (const bad of ["lm:beta:channel:x:log@1#a", "lm:acme:session:s1:log@1#a", "lm:acme:ask:t1", "lm:acme:channel:x:now", "acmi:acme:outbox", "lm:acme:oauth:x:who"]) {
    assert.throws(() => parseRef("acme", bad), { code: "bad_ref" }, bad);
  }
});

// ─── isolation ───────────────────────────────────────────────────────────

test("isolation: tenant A never sees B's points, even with B's exact text or a caller-supplied filter", async () => {
  const ctx = await setup();
  const { redis, qdrant, acme, beta } = ctx;
  const bText = "beta quarterly revenue forecast for the falcon launch";
  const b = await write(redis, beta, "beta", "channel", "plans", { kind: "memo", summary: bText, ts: 1791731538000 });
  const a = await write(redis, acme, "acme", "channel", "notes", { kind: "memo", summary: "acme lunch menu tuesday", ts: 1791731538001 });
  await drain(ctx, "beta");
  await drain(ctx, "acme");
  assert.equal(qdrant.points(COLLECTION).length, 2);

  const asB = await recall({ redis, qdrant, embed, tenant: "beta", query: bText });
  assert.equal(asB[0].ref, b.ref);
  assert.ok(asB[0].score > 0.8, "B finds its own entry with its own text");

  const hostile = await recall({
    redis,
    qdrant,
    embed,
    tenant: "acme",
    query: bText,
    filter: { must: [{ key: "tenant_id", match: { value: "beta" } }] },
    tenant_id: "beta",
    must: [],
  });
  assert.deepEqual(hostile.map((r) => r.ref), [a.ref]);
  for (const r of hostile) assert.ok(r.ref.startsWith("lm:acme:"));

  // Every search the server ran had tenant_id == caller as its first must clause.
  const searches = qdrant.calls.filter((c) => c[0] === "search");
  assert.deepEqual(searches.at(-1)[2].must[0], { key: "tenant_id", match: { value: "acme" } });

  // Over HTTP, extra body fields (tenant, tenant_id, filter, collection) are ignored.
  const handler = createRecallHandler({ redis, qdrant, embed, verifyKey: async (_r, t) => (t === "key-acme" ? { tenant: "acme" } : null), meter: async () => {} });
  const res = await handler.handle({
    method: "POST",
    headers: { authorization: "Bearer key-acme" },
    body: JSON.stringify({ query: bText, tenant: "beta", tenant_id: "beta", filter: { must: [] }, collection: "other", limit: 50 }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => r.ref), [a.ref]);
  assert.ok(!JSON.stringify(res.body).includes("falcon"));
});

test("isolation: a payload naming another tenant is dropped even if the store returns it", async () => {
  const redis = redisWithLists();
  const acme = createStore(redis, { space: "acme" });
  const a = await write(redis, acme, "acme", "channel", "x", { kind: "memo", summary: "hello world", ts: 1791731538000 });
  const leaky = {
    async search() {
      return [
        { id: "1", score: 0.99, payload: { tenant_id: "beta", ref: "lm:beta:channel:x:log@1#t" } },
        { id: "2", score: 0.98, payload: { tenant_id: "acme", ref: "lm:beta:channel:x:log@1#t" } },
        { id: "3", score: 0.5, payload: { tenant_id: "acme", ref: a.ref } },
      ];
    },
  };
  const out = await recall({ redis, qdrant: leaky, embed, tenant: "acme", query: "hello" });
  assert.deepEqual(out.map((r) => r.ref), [a.ref]);
});

// ─── redaction end to end ────────────────────────────────────────────────

test("redaction: a secret in an entry never reaches a Qdrant payload, the embedder or the logs", async () => {
  const ctx = await setup();
  const { redis, qdrant, acme } = ctx;
  const secret = "sk-" + "ant-api03-" + "Zx9".repeat(12);
  const ghp = "ghp_" + "Q1w2E3r4".repeat(5);
  await write(redis, acme, "acme", "channel", "ops", {
    kind: "memo",
    summary: `rotated the key ${secret} today`,
    payload: { note: `fallback ${ghp}`, url: "https://bot:pa55word@git.example.com/x" },
    ts: 1791731538000,
  });
  const seen = [];
  const spyEmbed = async (texts) => {
    seen.push(...texts);
    return embed(texts);
  };
  spyEmbed.dim = embed.dim;
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const consoleOut = [];
  for (const k of Object.keys(orig)) console[k] = (...a) => consoleOut.push(a.map(String).join(" "));
  try {
    await indexOnce({ redis, qdrant, embed: spyEmbed, tenant: "acme", log: (e) => logs.push(e) });
  } finally {
    Object.assign(console, orig);
  }
  const pts = qdrant.points(COLLECTION);
  assert.equal(pts.length, 1);
  const blob = JSON.stringify(pts.map((p) => p.payload)) + JSON.stringify(seen) + JSON.stringify(logs) + consoleOut.join("\n");
  for (const s of [secret, ghp, "pa55word"]) assert.ok(!blob.includes(s), `secret leaked: ${s.slice(0, 5)}`);
  assert.match(pts[0].payload.chunk, /rotated the key \[REDACTED\] today/);
  assert.deepEqual(Object.keys(pts[0].payload).sort(), ["chunk", "chunk_index", "content_hash", "index_version", "kind", "ref", "tenant_id", "ts_ms"]);
  assert.equal(pts[0].payload.index_version, 1);
  assert.equal(pts[0].payload.tenant_id, "acme");
  // Redis (canonical) is untouched: the owner still sees their own entry in full.
  const [hit] = await recall({ redis, qdrant, embed, tenant: "acme", query: "rotated the key today" });
  assert.ok(hit.entry.summary.includes(secret));
});

// ─── deterministic ids ───────────────────────────────────────────────────

test("deterministic ids: re-indexing the same entry is idempotent", async () => {
  const ctx = await setup();
  const { redis, qdrant, acme } = ctx;
  const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
  const w = await write(redis, acme, "acme", "channel", "ops", { kind: "memo", summary: long, ts: 1791731538000 });
  await drain(ctx, "acme");
  const first = qdrant.points(COLLECTION);
  assert.ok(first.length > 1, "long entry is chunked");
  await enqueue(redis, "acme", { ref: w.ref, kind: "memo", ts: w.entry.ts });
  await enqueue(redis, "acme", { ref: w.ref, kind: "memo", ts: w.entry.ts });
  await drain(ctx, "acme");
  const again = qdrant.points(COLLECTION);
  assert.deepEqual(again.map((p) => p.id).sort(), first.map((p) => p.id).sort());
  assert.deepEqual(again.map((p) => p.payload.content_hash), first.map((p) => p.payload.content_hash));
  assert.equal(pointId("acme", w.ref, 0), pointId("acme", w.ref, 0));
  assert.notEqual(pointId("acme", w.ref, 0), pointId("beta", w.ref, 0));
  assert.match(pointId("acme", w.ref, 0), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("deterministic ids: a document that shrinks leaves no stale chunks", async () => {
  const ctx = await setup();
  const { redis, qdrant, acme } = ctx;
  await acme.setWho("agent", "quill", { bio: Array.from({ length: 400 }, (_, i) => `fact${i}`).join(" ") });
  const ref = acme.key("agent", "quill", "who");
  await enqueue(redis, "acme", { ref, kind: "who" });
  await drain(ctx, "acme");
  assert.ok(qdrant.points(COLLECTION).length > 2);
  await acme.setWho("agent", "quill", { bio: "short now" });
  await enqueue(redis, "acme", { ref, kind: "who" });
  await drain(ctx, "acme");
  const pts = qdrant.points(COLLECTION);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].id, pointId("acme", ref, 0));
  assert.equal(pts[0].payload.kind, "who");
});

// ─── DLQ ─────────────────────────────────────────────────────────────────

test("dlq: after maxAttempts failures the item moves to the dead-letter list with a code, not a message", async () => {
  const ctx = await setup();
  const { redis, acme } = ctx;
  const mem = createMemoryQdrant();
  let upserts = 0;
  const flaky = {
    ...mem,
    async upsert() {
      upserts++;
      throw new Error("boom: secret sk-" + "x".repeat(30));
    },
  };
  const w = await write(redis, acme, "acme", "channel", "ops", { kind: "memo", summary: "will fail", ts: 1791731538000 });
  const logs = [];
  const run = () => indexOnce({ redis, qdrant: flaky, embed, tenant: "acme", maxAttempts: 3, backoffMs: 0, log: (e) => logs.push(e) });
  assert.equal((await run()).retried, 1);
  assert.equal((await run()).retried, 1);
  const last = await run();
  assert.equal(last.dead, 1);
  assert.equal(upserts, 3);
  assert.equal(await redis("LLEN", outboxKey("acme")), 0);
  assert.equal(await redis("HGET", retryKey("acme"), w.ref), null);
  const dlq = (await redis("LRANGE", dlqKey("acme"), 0, -1)).map((x) => JSON.parse(x));
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0].ref, w.ref);
  assert.equal(dlq[0].attempts, 3);
  assert.equal(dlq[0].error, "index_failed");
  assert.ok(!JSON.stringify(dlq).includes("boom") && !JSON.stringify(logs).includes("boom"));
});

test("dlq: backoff defers a failed item until its next attempt time; bad items go straight to the dlq", async () => {
  const ctx = await setup();
  const { redis, acme } = ctx;
  let fail = true;
  const mem = createMemoryQdrant();
  const q = { ...mem, upsert: async (n, p) => (fail ? Promise.reject(Object.assign(new Error("x"), { code: "qdrant_error" })) : mem.upsert(n, p)) };
  await write(redis, acme, "acme", "channel", "ops", { kind: "memo", summary: "eventually", ts: 1791731538000 });
  let t = 1_000_000;
  const run = () => indexOnce({ redis, qdrant: q, embed, tenant: "acme", backoffMs: 1000, now: () => t });
  assert.equal((await run()).retried, 1);
  assert.equal((await run()).deferred, 1, "too early: deferred, no attempt");
  t += 1000;
  fail = false;
  const ok = await run();
  assert.equal(ok.indexed, 1);
  assert.equal(mem.points(COLLECTION).length, 1);

  await redis("RPUSH", outboxKey("acme"), "not json");
  await redis("RPUSH", outboxKey("acme"), JSON.stringify({ ref: "lm:beta:channel:x:log@1#t", kind: "memo", ts: 1 }));
  const s = await run();
  assert.equal(s.dead, 2);
  const dlq = (await redis("LRANGE", dlqKey("acme"), 0, -1)).map((x) => JSON.parse(x));
  assert.deepEqual(dlq.map((d) => d.error), ["bad_item", "bad_ref"]);
  assert.ok(!JSON.stringify(dlq).includes("lm:beta:"), "a foreign ref is not copied into this tenant's dlq");
});

// ─── rebuild ─────────────────────────────────────────────────────────────

test("rebuild: after the Qdrant double is wiped, the index comes back from Redis alone", async () => {
  const ctx = await setup();
  const { redis, qdrant, acme, beta } = ctx;
  const a1 = await write(redis, acme, "acme", "channel", "ops", { kind: "memo", summary: "kafka consumer lag alert", ts: 1791731538000 });
  const a2 = await write(redis, acme, "acme", "job", "issue-14", { kind: "done", summary: "shipped the onboarding fix", ts: 1791731539000 });
  await acme.setWho("agent", "quill", { bio: "quill writes the field notes" });
  // A legacy ACMI timeline with second-resolution scores and correlationIds.
  await redis("ZADD", "acmi:acme:thread:legacy:timeline", 1791731540, JSON.stringify({ ts: 1791731540, source: "agent:x", kind: "coord-note", correlationId: "legacyCid-1", summary: "legacy redis migration note" }));
  await beta.append("channel", "x", { kind: "memo", summary: "beta stays put", ts: 1791731538000 });
  await enqueue(redis, "beta", { ref: logRef(beta.key("channel", "x", "log"), 1791731538000, (await redis("ZRANGE", beta.key("channel", "x", "log"), 0, -1))[0]) });
  await drain(ctx, "acme");
  await drain(ctx, "beta");
  assert.equal((await recall({ redis, qdrant, embed, tenant: "acme", query: "kafka consumer lag alert" }))[0].ref, a1.ref);

  qdrant.wipe();
  await assert.rejects(recall({ redis, qdrant, embed, tenant: "acme", query: "kafka" }));

  const r = await rebuild({ redis, qdrant, embed, tenant: "acme" });
  assert.equal(r.enqueued, 4);
  await drain(ctx, "acme");
  const refs = new Set(qdrant.points(COLLECTION).map((p) => p.payload.ref));
  assert.ok(refs.has(a1.ref) && refs.has(a2.ref) && refs.has(acme.key("agent", "quill", "who")));
  assert.ok([...refs].some((x) => x === "acmi:acme:thread:legacy:timeline@1791731540#legacyCid-1"));
  assert.equal((await recall({ redis, qdrant, embed, tenant: "acme", query: "kafka consumer lag alert" }))[0].ref, a1.ref);
  const legacy = await recall({ redis, qdrant, embed, tenant: "acme", query: "legacy redis migration note", limit: 1 });
  assert.equal(legacy[0].kind, "memo", "ACMI coord-note maps to the LogMem kind");
  assert.equal(legacy[0].ts, 1791731540000, "seconds normalised to ms");
  assert.ok(qdrant.points(COLLECTION).every((p) => p.payload.tenant_id === "acme"));
});

test("rebuild: one tenant's rebuild deletes only its own points", async () => {
  const ctx = await setup();
  const { redis, qdrant, acme, beta } = ctx;
  await write(redis, acme, "acme", "channel", "ops", { kind: "memo", summary: "a", ts: 1791731538000 });
  await write(redis, beta, "beta", "channel", "ops", { kind: "memo", summary: "b", ts: 1791731538000 });
  await drain(ctx, "acme");
  await drain(ctx, "beta");
  await rebuild({ redis, qdrant, embed, tenant: "acme" });
  const left = qdrant.points(COLLECTION).map((p) => p.payload.tenant_id);
  assert.deepEqual(left, ["beta"]);
  assert.deepEqual(qdrant.calls.find((c) => c[0] === "delete" && c[2].must.length === 1)[2], { must: [{ key: "tenant_id", match: { value: "acme" } }] });
});

// ─── hydration ───────────────────────────────────────────────────────────

test("hydration: a hit whose canonical entry was deleted is dropped; re-indexing removes its points", async () => {
  const ctx = await setup();
  const { redis, qdrant, acme } = ctx;
  const keep = await write(redis, acme, "acme", "channel", "ops", { kind: "memo", summary: "postgres failover drill", ts: 1791731538000 });
  const gone = await write(redis, acme, "acme", "channel", "ops", { kind: "memo", summary: "postgres failover drill notes", ts: 1791731538001 });
  await drain(ctx, "acme");
  assert.equal((await recall({ redis, qdrant, embed, tenant: "acme", query: "postgres failover drill" })).length, 2);
  assert.equal(await acme.removeEntry("channel", "ops", gone.entry), 1);
  assert.equal(await loadEntry(redis, "acme", gone.ref), null);
  const out = await recall({ redis, qdrant, embed, tenant: "acme", query: "postgres failover drill" });
  assert.deepEqual(out.map((r) => r.ref), [keep.ref]);
  assert.equal(out[0].entry.summary, "postgres failover drill");
  assert.equal(out[0].entry._o, undefined);
  await enqueue(redis, "acme", { ref: gone.ref });
  const s = await indexOnce({ redis, qdrant, embed, tenant: "acme" });
  assert.equal(s.removed, 1);
  assert.ok(!qdrant.points(COLLECTION).some((p) => p.payload.ref === gone.ref));
});

test("recall: kinds and since narrow inside the tenant filter", async () => {
  const ctx = await setup();
  const { redis, qdrant, acme } = ctx;
  await write(redis, acme, "acme", "channel", "ops", { kind: "memo", summary: "release train friday", ts: 1791731538000 });
  const done = await write(redis, acme, "acme", "channel", "ops", { kind: "done", summary: "release train friday shipped", ts: 1791731600000 });
  await drain(ctx, "acme");
  const onlyDone = await recall({ redis, qdrant, embed, tenant: "acme", query: "release train", kinds: ["done"] });
  assert.deepEqual(onlyDone.map((r) => r.ref), [done.ref]);
  const recent = await recall({ redis, qdrant, embed, tenant: "acme", query: "release train", since: new Date(1791731590000).toISOString() });
  assert.deepEqual(recent.map((r) => r.ref), [done.ref]);
  const f = qdrant.calls.filter((c) => c[0] === "search").at(-1)[2];
  assert.deepEqual(f.must[0], { key: "tenant_id", match: { value: "acme" } });
  await assert.rejects(recall({ redis, qdrant, embed, tenant: "acme", query: "" }), { code: "bad_request" });
  await assert.rejects(recall({ redis, qdrant, embed, tenant: "acme", query: "x", limit: 51 }), { code: "bad_request" });
  await assert.rejects(recall({ redis, qdrant, embed, tenant: "../x", query: "x" }), { code: "bad_tenant" });
});

// ─── handler ─────────────────────────────────────────────────────────────

test("handler: 401 without a valid key, meter only after a successful recall, generic errors", async () => {
  const ctx = await setup();
  const { redis, qdrant, acme } = ctx;
  await write(redis, acme, "acme", "channel", "ops", { kind: "memo", summary: "rotate on-call", ts: 1791731538000 });
  await drain(ctx, "acme");
  const metered = [];
  const verifyKey = async (r, token) => {
    assert.equal(r, redis);
    return token === "acmi_live_k1_good" ? { tenant: "acme", keyid: "k1" } : null;
  };
  const h = createRecallHandler({ redis, qdrant, embed, verifyKey, meter: async (...a) => metered.push(a) });
  const post = (headers, body) => h.handle({ method: "POST", headers, body });

  assert.equal((await post({}, { query: "x" })).status, 401);
  assert.equal((await post({ authorization: "Basic abc" }, { query: "x" })).status, 401);
  const wrong = await post({ authorization: "Bearer acmi_live_k1_wrong" }, { query: "x" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { error: "unauthorized" });
  assert.ok(!JSON.stringify(wrong.body).includes("wrong"));
  const throws = createRecallHandler({ redis, qdrant, embed, verifyKey: async () => { throw new Error("redis down"); }, meter: async () => metered.push("x") });
  assert.equal((await throws.handle({ method: "POST", headers: { authorization: "Bearer t" }, body: { query: "x" } })).status, 401);
  assert.equal((await h.handle({ method: "GET", headers: { authorization: "Bearer acmi_live_k1_good" } })).status, 405);
  assert.equal((await post({ authorization: "Bearer acmi_live_k1_good" }, "{not json")).status, 400);
  assert.equal((await post({ authorization: "Bearer acmi_live_k1_good" }, { query: "x", limit: 0 })).status, 400);
  assert.equal(metered.length, 0, "no meter call on any failure");

  const ok = await post({ authorization: "Bearer acmi_live_k1_good" }, JSON.stringify({ query: "rotate on-call", limit: 5 }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.results.length, 1);
  assert.deepEqual(Object.keys(ok.body.results[0]).sort(), ["entry", "kind", "ref", "score", "ts"]);
  assert.deepEqual(metered, [[redis, "acme", "recall", 1]]);

  // A qdrant failure is a generic 500 and is not metered.
  const broken = createRecallHandler({ redis, qdrant: { search: async () => { throw new Error("qdrant at 10.0.0.5 said no"); } }, embed, verifyKey, meter: async (...a) => metered.push(a) });
  const e = await broken.handle({ method: "POST", headers: { authorization: "Bearer acmi_live_k1_good" }, body: { query: "x" } });
  assert.equal(e.status, 500);
  assert.deepEqual(e.body, { error: "internal_error" });
  assert.equal(metered.length, 1);

  // Node-style (req, res) wrapper, body streamed.
  const { Readable } = await import("node:stream");
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ query: "rotate on-call" }))]), { method: "POST", headers: { authorization: "Bearer acmi_live_k1_good" } });
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  await h(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(JSON.parse(res.body).results.length, 1);
  assert.equal(metered.length, 2);
});

// ─── real qdrant.mjs request shapes ──────────────────────────────────────

function mockFetch(responder) {
  const calls = [];
  const f = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const { status = 200, json = { result: true, status: "ok" } } = (await responder(call)) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  f.calls = calls;
  return f;
}

test("qdrant.mjs: REST request shapes (collection, payload index, upsert, search, delete)", async () => {
  const apiKey = "qdrant-test-key-not-real";
  const fetch = mockFetch((c) => (c.method === "GET" ? { status: 404, json: { status: { error: "Not found" } } } : c.url.endsWith("/points/search") ? { json: { result: [{ id: "u1", score: 0.9, payload: { ref: "r" }, vector: null }] } } : {}));
  const q = createQdrant({ url: "https://qdrant.example.test:6333/", apiKey, fetch });

  assert.deepEqual(await q.ensureCollection("acmi_memory_v1", 64), { created: true });
  assert.equal(fetch.calls[0].method, "GET");
  assert.equal(fetch.calls[0].url, "https://qdrant.example.test:6333/collections/acmi_memory_v1");
  assert.deepEqual(fetch.calls[1], {
    url: "https://qdrant.example.test:6333/collections/acmi_memory_v1",
    method: "PUT",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: { vectors: { size: 64, distance: "Cosine" } },
  });

  await q.ensurePayloadIndex("acmi_memory_v1", "tenant_id", { type: "keyword", is_tenant: true });
  assert.equal(fetch.calls[2].method, "PUT");
  assert.equal(fetch.calls[2].url, "https://qdrant.example.test:6333/collections/acmi_memory_v1/index?wait=true");
  assert.deepEqual(fetch.calls[2].body, { field_name: "tenant_id", field_schema: { type: "keyword", is_tenant: true } });

  await q.upsert("acmi_memory_v1", [{ id: "u1", vector: [0.1, 0.2], payload: { tenant_id: "acme" }, extra: "dropped" }]);
  assert.equal(fetch.calls[3].method, "PUT");
  assert.equal(fetch.calls[3].url, "https://qdrant.example.test:6333/collections/acmi_memory_v1/points?wait=true");
  assert.deepEqual(fetch.calls[3].body, { points: [{ id: "u1", vector: [0.1, 0.2], payload: { tenant_id: "acme" } }] });

  const filter = { must: [{ key: "tenant_id", match: { value: "acme" } }] };
  const hits = await q.search("acmi_memory_v1", [0.1, 0.2], { filter, limit: 7 });
  assert.equal(fetch.calls[4].method, "POST");
  assert.equal(fetch.calls[4].url, "https://qdrant.example.test:6333/collections/acmi_memory_v1/points/search");
  assert.deepEqual(fetch.calls[4].body, { vector: [0.1, 0.2], limit: 7, with_payload: true, with_vector: false, filter });
  assert.deepEqual(hits, [{ id: "u1", score: 0.9, payload: { ref: "r" } }]);

  await q.delete("acmi_memory_v1", filter);
  assert.equal(fetch.calls[5].method, "POST");
  assert.equal(fetch.calls[5].url, "https://qdrant.example.test:6333/collections/acmi_memory_v1/points/delete?wait=true");
  assert.deepEqual(fetch.calls[5].body, { filter });
  assert.equal(fetch.calls.length, 6);
  assert.equal(await q.upsert("acmi_memory_v1", []).then((r) => r.upserted), 0, "empty upsert makes no request");
  assert.equal(fetch.calls.length, 6);
});

test("qdrant.mjs: existing collection, dim mismatch, errors never carry the key or body", async () => {
  const apiKey = "qdrant-test-key-not-real";
  const exists = mockFetch(() => ({ json: { result: { config: { params: { vectors: { size: 64, distance: "Cosine" } } } } } }));
  const q = createQdrant({ url: "http://localhost:6333", apiKey, fetch: exists });
  assert.deepEqual(await q.ensureCollection("acmi_memory_v1", 64), { created: false });
  assert.equal(exists.calls.length, 1, "no PUT when it exists");
  await assert.rejects(q.ensureCollection("acmi_memory_v1", 128), { code: "dim_mismatch" });

  const failing = mockFetch(() => ({ status: 500, json: { status: { error: `bad payload with ${apiKey} and text` } } }));
  const q2 = createQdrant({ url: "http://localhost:6333", apiKey, fetch: failing });
  await assert.rejects(q2.search("acmi_memory_v1", [1], {}), (e) => {
    assert.equal(e.code, "qdrant_error");
    assert.equal(e.status, 500);
    assert.ok(!e.message.includes(apiKey) && !e.message.includes("text"));
    return true;
  });
  const down = createQdrant({ url: "http://localhost:6333", apiKey, fetch: async () => { throw new Error(`ECONNREFUSED ${apiKey}`); } });
  await assert.rejects(down.delete("acmi_memory_v1", { must: [] }), (e) => !e.message.includes(apiKey));
  assert.throws(() => createQdrant({ url: "ftp://x", fetch: exists }), { code: "bad_config" });
  await assert.rejects(q.upsert("../etc", [{ id: 1 }]), { code: "bad_collection" });
  await assert.rejects(q.delete("acmi_memory_v1"), { code: "bad_filter" });
  const noKey = mockFetch(() => ({}));
  await createQdrant({ url: "http://localhost:6333", fetch: noKey }).delete("c", { must: [] });
  assert.equal(noKey.calls[0].headers["api-key"], undefined);
});

// ─── pieces ──────────────────────────────────────────────────────────────

test("memory qdrant: must / must_not / should / any / range filters", () => {
  const p = { tenant_id: "acme", kind: "memo", ts_ms: 10 };
  assert.ok(filterMatches(p, { must: [{ key: "tenant_id", match: { value: "acme" } }] }));
  assert.ok(!filterMatches(p, { must: [{ key: "tenant_id", match: { value: "beta" } }] }));
  assert.ok(filterMatches(p, { must: [{ key: "kind", match: { any: ["done", "memo"] } }] }));
  assert.ok(!filterMatches(p, { must_not: [{ key: "kind", match: { value: "memo" } }] }));
  assert.ok(filterMatches(p, { should: [{ key: "kind", match: { value: "x" } }, { key: "ts_ms", range: { gte: 10 } }] }));
  assert.ok(!filterMatches(p, { must: [{ key: "ts_ms", range: { gt: 10 } }] }));
  assert.throws(() => filterMatches(p, { min_should: {} }));
  assert.throws(() => filterMatches(p, { must: [{ has_id: [1] }] }));
});

test("chunkText: ~800-char windows with 100 chars of overlap; short text is one chunk", () => {
  assert.deepEqual(chunkText("short"), ["short"]);
  assert.deepEqual(chunkText(""), [""]);
  const text = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 800);
  for (let i = 1; i < chunks.length; i++) {
    const tail = chunks[i - 1].slice(-100);
    assert.ok(chunks[i].startsWith(tail), "next chunk starts with the previous chunk's last 100 chars");
  }
  assert.ok(chunks.at(-1).endsWith("w599"));
  const solid = "x".repeat(2000);
  assert.ok(chunkText(solid).every((c) => c.length <= 800));
});

test("fakeEmbedder: deterministic, unit length, similar text scores higher", async () => {
  const e = fakeEmbedder({ dim: 32 });
  const [a, a2, b, empty] = await e(["deploy the bridge", "deploy the bridge", "lunch menu", ""]);
  assert.deepEqual(a, a2);
  assert.equal(a.length, 32);
  const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm(a) - 1) < 1e-9 && Math.abs(norm(empty) - 1) < 1e-9);
  const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
  const [q] = await e(["deploy bridge"]);
  assert.ok(dot(q, a) > dot(q, b));
  assert.equal(e.dim, 32);
});
