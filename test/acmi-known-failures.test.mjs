// Regression tests for failures the ACMI fleet hit in production (madez,
// 2026-10). Each test seeds the exact dirty shape seen in the 2026-10-11
// dry run or in live tool calls, then checks LogMem compat mode survives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore, normTs } from "../src/core/store.mjs";
import { createLogmem } from "../src/server.mjs";
import { buildView } from "../src/http/view.mjs";

const S = "madez";
const call = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;
const ev = (ts, summary, extra = {}) => ({ ts, source: "agent:muse", kind: "coord-note", correlationId: `c${ts}`, summary, ...extra });

test("WRONGTYPE: a string-typed legacy timeline (JSON array) reads instead of throwing", async () => {
  const redis = createMemoryRedis();
  await redis("SET", `acmi:${S}:work:gsd-dashboard-client-access:timeline`, JSON.stringify([ev(1791700000000, "first"), ev(1791700001000, "second")]));
  const st = createStore(redis, { space: S, compat: true });
  const log = await st.readLog("job", "gsd-dashboard-client-access");
  assert.deepEqual(log.map((e) => e.summary), ["first", "second"]);
  assert.equal(await st.logSize("job", "gsd-dashboard-client-access"), 2);
});

test("WRONGTYPE: a list-typed legacy timeline reads too", async () => {
  const redis = createMemoryRedis();
  await redis("RPUSH", `acmi:${S}:thread:legacy-list:timeline`, JSON.stringify(ev(1791700000000, "from a list")));
  const st = createStore(redis, { space: S, compat: true });
  assert.deepEqual((await st.readLog("channel", "legacy-list")).map((e) => e.summary), ["from a list"]);
});

test("WRONGTYPE: a hash-typed legacy profile and rollup read as objects", async () => {
  const redis = createMemoryRedis();
  await redis("HSET", `acmi:${S}:agent:legacyhash:profile`, "name", JSON.stringify("Legacy"), "role", JSON.stringify("x"));
  await redis("HSET", `acmi:${S}:agent:legacyhash:rollup:latest`, "session_summary", JSON.stringify("done"));
  const st = createStore(redis, { space: S, compat: true });
  assert.deepEqual(await st.getWho("agent", "legacyhash"), { name: "Legacy", role: "x" });
  assert.deepEqual(await st.getRecap("legacyhash"), { session_summary: "done" });
});

test("ISO-string ts: normTs parses it instead of returning 0 (1970)", () => {
  assert.equal(normTs("2026-10-12T20:52:00Z"), Date.parse("2026-10-12T20:52:00Z"));
  assert.equal(normTs("2026-10-12 20:52Z"), Date.parse("2026-10-12T20:52Z"));
  assert.equal(normTs("1791731538741"), 1791731538741, "numeric strings still go through Number");
  assert.equal(normTs("not a date"), 0);
});

test("ISO-string ts: an appended entry keeps its real time and stays inside a since window", async () => {
  const redis = createMemoryRedis();
  const st = createStore(redis, { space: S });
  const e = await st.append("channel", "iso", { by: "agent:t", kind: "memo", trail: "t1", summary: "iso", ts: "2026-10-12T20:52:00Z" });
  assert.equal(new Date(e.ts).toISOString(), "2026-10-12T20:52:00.000Z");
  const since = Date.parse("2026-10-12T00:00:00Z");
  assert.deepEqual((await st.readLog("channel", "iso", { sinceMs: since })).map((x) => x.summary), ["iso"]);
});

test("blank members: an empty-string ZSET member is skipped, not shown as a blank entry", async () => {
  const redis = createMemoryRedis();
  const tl = `acmi:${S}:thread:agent-coordination:timeline`;
  await redis("ZADD", tl, 1791853000000, "");
  await redis("ZADD", tl, 1791853000500, "   ");
  await redis("ZADD", tl, 1791853001000, JSON.stringify(ev(1791853001000, "real")));
  const st = createStore(redis, { space: S, compat: true });
  assert.deepEqual((await st.readLog("channel", "agent-coordination")).map((e) => e.summary), ["real"]);
  assert.equal(await st.logSize("channel", "agent-coordination"), 1);
});

test("mixed units: ns-scored legacy events sort and filter as ms", async () => {
  const redis = createMemoryRedis();
  const tl = `acmi:${S}:thread:agent-coordination:timeline`;
  const ms = 1791853034186;
  await redis("ZADD", tl, ms * 1e6, JSON.stringify(ev(ms * 1e6, "ns event")));
  await redis("ZADD", tl, ms - 1000, JSON.stringify(ev(ms - 1000, "ms event")));
  const st = createStore(redis, { space: S, compat: true });
  const log = await st.readLog("channel", "agent-coordination", { sinceMs: ms - 5000 });
  assert.deepEqual(log.map((e) => e.summary), ["ms event", "ns event"]);
  assert.equal(log[1].ts, ms);
});

test("feed: one unreadable log is reported in read_warnings, the rest still merge", async () => {
  const redis = createMemoryRedis();
  await redis("ZADD", `acmi:${S}:thread:good:timeline`, 1791700000000, JSON.stringify(ev(1791700000000, "good")));
  // A legacy timeline key holding a SET cannot be read: empty, with a warning.
  await redis("SADD", `acmi:${S}:thread:weird:timeline`, "x");
  // An lm log key holding the wrong type throws WRONGTYPE from Redis itself.
  await redis("SET", `lm:${S}:channel:broken:log`, "x");
  const lm = createLogmem({ redis, space: S, surface: "test", sessionId: "s1", defaultAgent: "relay", compat: true });
  const feed = await call(lm, "logmem_feed", { refs: ["channel:good", "channel:weird", "channel:broken", "channel:undefined"] });
  assert.equal(feed.ok, true);
  assert.ok(feed.entries.some((e) => e.summary === "good"));
  assert.ok(Array.isArray(feed.read_warnings), "bad refs are reported");
  assert.deepEqual(
    feed.read_warnings.map((w) => `${w.ref}:${w.code}`).sort(),
    ["channel:broken:read_failed", "channel:undefined:read_failed", "channel:weird:unreadable_type"],
  );
  for (const w of feed.read_warnings) {
    assert.equal(w.error, undefined, "raw error text is not a warning field");
    assert.equal(typeof w.message, "string");
  }
});

test("acmi_cat compat: a WRONGTYPE timeline no longer fails the whole merge", async () => {
  const redis = createMemoryRedis();
  await redis("ZADD", `acmi:${S}:thread:good:timeline`, 1791700000000, JSON.stringify(ev(1791700000000, "good")));
  await redis("SET", `acmi:${S}:work:stringy:timeline`, JSON.stringify([ev(1791700002000, "stringy")]));
  await redis("HSET", `acmi:${S}:work:hashed:timeline`, "a", "b");
  const lm = createLogmem({ redis, space: S, surface: "test", sessionId: "s1", defaultAgent: "relay", compat: true });
  await redis("SET", `lm:${S}:job:broken:log`, "x");
  const r = await call(lm, "acmi_cat", { keys: ["thread:good", "work:stringy", "work:hashed", "work:broken", "work:undefined"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.events.map((e) => e.summary).sort(), ["good", "stringy"]);
  assert.deepEqual(
    r.read_warnings?.map((w) => `${w.key}:${w.code}`).sort(),
    ["work:broken:read_failed", "work:hashed:unreadable_type", "work:undefined:read_failed"],
  );
  for (const w of r.read_warnings) assert.equal(w.error, undefined);
});

// ─── A1: legacy ACMI status -> LogMem stage (decision 2026-10-13) ────────
test("A1: legacy job status maps to stage on compat read; LogMem stage wins; status kept", async () => {
  const redis = createMemoryRedis();
  const sig = (id, status) => redis("HSET", `acmi:${S}:work:${id}:signals`, "status", status);
  await sig("culled", "archived");
  await sig("merged-dup", "merged");
  await sig("shipped", "completed");
  await sig("stuck", "stalled");
  await sig("waiting", "pending");
  await sig("weird", "acknowledged-ish");
  await sig("overridden", "archived");
  await redis("HSET", `lm:${S}:job:overridden:now`, "stage", JSON.stringify("active"));
  const st = createStore(redis, { space: S, compat: true });
  const stage = async (id) => (await st.getNow("job", id)).stage;
  assert.equal(await stage("culled"), "done");
  assert.equal(await stage("merged-dup"), "done");
  assert.equal(await stage("shipped"), "done");
  assert.equal(await stage("stuck"), "blocked");
  assert.equal(await stage("waiting"), "open");
  assert.equal(await stage("weird"), undefined, "unknown statuses map to nothing");
  assert.equal(await stage("overridden"), "active", "a LogMem stage wins over the legacy status");
  const over = await st.getNow("job", "overridden");
  assert.equal(Object.hasOwn(over, "stage_from"), false, "stage_from is absent when the LogMem stage wins");
  assert.equal((await st.getNow("job", "culled")).stage_from, "acmi_status", "a derived stage keeps the marker");
  assert.equal((await st.getNow("job", "culled")).status, "archived", "original status kept");
  assert.equal(await redis("HGET", `acmi:${S}:work:culled:signals`, "status"), "archived", "acmi:* untouched");
  // Channels and agents never get a derived stage.
  await redis("HSET", `acmi:${S}:thread:t1:signals`, "status", "archived");
  assert.equal((await st.getNow("channel", "t1")).stage, undefined);
});

test("A1: logmem_jobs hides done by default; include_done and stage=done show them", async () => {
  const redis = createMemoryRedis();
  for (const [id, status] of [["a", "archived"], ["b", "pending"], ["c", "completed"], ["d", "stalled"]]) {
    await redis("SADD", `acmi:${S}:work:list`, id);
    await redis("HSET", `acmi:${S}:work:${id}:signals`, "status", status);
  }
  const lm = createLogmem({ redis, space: S, surface: "test", sessionId: "s1", defaultAgent: "relay", compat: true });
  const def = await call(lm, "logmem_jobs", {});
  assert.deepEqual(def.jobs, ["b", "d"]);
  assert.equal(def.hidden_done, 2);
  assert.deepEqual((await call(lm, "logmem_jobs", { include_done: true })).jobs, ["a", "b", "c", "d"]);
  assert.deepEqual((await call(lm, "logmem_jobs", { stage: "done" })).jobs, ["a", "c"]);
  assert.deepEqual((await call(lm, "logmem_jobs", { stage: "blocked" })).jobs, ["d"]);
  assert.equal(def.read_warnings, undefined, "a clean jobs read has no warnings");
});

test("legacy timeline: an unreadable Redis type warns; a missing key does not", async () => {
  const redis = createMemoryRedis();
  await redis("SADD", `acmi:${S}:work:weird:timeline`, "x");
  await redis("HSET", `acmi:${S}:thread:hashed:timeline`, "k", "v");
  const st = createStore(redis, { space: S, compat: true });
  const weird = await st.readLog("job", "weird");
  const hashed = await st.readLog("channel", "hashed");
  const missing = await st.readLog("job", "no-such-job");
  assert.deepEqual([...weird], []);
  assert.deepEqual([...hashed], []);
  assert.deepEqual([...missing], []);
  assert.equal(weird.warnings[0].code, "unreadable_type");
  assert.match(weird.warnings[0].message, /type 'set'/);
  assert.equal(hashed.warnings[0].code, "unreadable_type");
  assert.match(hashed.warnings[0].message, /type 'hash'/);
  assert.equal(missing.warnings, undefined, "a missing timeline is empty with no warning");
  assert.equal(await st.logSize("job", "weird"), 0);
  const lm = createLogmem({ redis, space: S, surface: "test", sessionId: "s1", defaultAgent: "relay", compat: true });
  const view = await call(lm, "logmem_view", { ref: "job:weird" });
  assert.deepEqual(view.log, []);
  assert.equal(view.read_warnings[0].code, "unreadable_type");
  assert.equal(view.read_warnings[0].ref, "job:weird");
  const open = await call(lm, "logmem_open", { job: "weird" });
  assert.equal(open.read_warnings[0].code, "unreadable_type");
});

test("read_warnings use a fixed code and never carry a Redis REST token or endpoint", async () => {
  const token = "upstashRestToken_DoNotLeak_99";
  const endpoint = "https://madez-tenant.upstash.io/bridge";
  const host = "madez-tenant.upstash.io";
  const redis = createMemoryRedis();
  await redis("SADD", `lm:${S}:job:list`, "ok", "bad");
  await redis("HSET", `lm:${S}:job:ok:now`, "stage", JSON.stringify("active"));
  await redis("ZADD", `acmi:${S}:thread:good:timeline`, 1791700000000, JSON.stringify(ev(1791700000000, "good")));
  const leak = `Redis REST HGETALL: ERR ${endpoint} Bearer ${token} token=${token} at ${host}`;
  const wrapped = async (cmd, ...args) => {
    const key = String(args[0] ?? "");
    if (key.includes(":job:bad:") || key.includes(":work:bad:") || key.includes(":channel:leaky:") || key.includes(":thread:leaky:")) {
      throw new Error(leak);
    }
    return redis(cmd, ...args);
  };
  const lm = createLogmem({ redis: wrapped, space: S, surface: "test", sessionId: "s1", defaultAgent: "relay", compat: true });
  const feed = await call(lm, "logmem_feed", { refs: ["channel:good", "channel:leaky"] });
  const jobs = await call(lm, "logmem_jobs", { stage: "active" });
  const cat = await call(lm, "acmi_cat", { keys: ["thread:good", "thread:leaky"] });
  const def = await call(lm, "logmem_jobs", {});
  assert.deepEqual(feed.entries.map((e) => e.summary), ["good"]);
  assert.equal(feed.read_warnings[0].ref, "channel:leaky");
  assert.equal(feed.read_warnings[0].code, "read_failed");
  assert.deepEqual(jobs.jobs, ["ok"], "a failed getNow does not match the stage filter");
  assert.equal(jobs.read_warnings[0].ref, "job:bad");
  assert.equal(jobs.read_warnings[0].code, "read_failed");
  assert.ok(def.jobs.includes("bad"), "a failed getNow is not treated as done");
  assert.equal(def.hidden_done, 0);
  assert.equal(def.read_warnings[0].code, "read_failed");
  assert.equal(cat.read_warnings[0].key, "thread:leaky");
  assert.equal(cat.read_warnings[0].code, "read_failed");
  for (const body of [feed, jobs, cat, def]) {
    const blob = JSON.stringify(body);
    assert.ok(!blob.includes(token), blob);
    assert.ok(!blob.includes(endpoint), blob);
    assert.ok(!blob.includes(host), blob);
    assert.ok(!blob.includes("Bearer"), blob);
    assert.ok(!body.read_warnings.some((w) => "error" in w));
  }
});

test("recall and views: a legacy index id containing colons is reported or skipped, not fatal", async () => {
  const redis = createMemoryRedis();
  await redis("SADD", `acmi:${S}:work:list`, "client:duane:duane-lead-pipeline", "logmem-google-search-setup");
  await redis("SADD", `lm:${S}:job:list`, "client:duane:duane-lead-pipeline", "logmem-google-search-setup");
  await redis("ZADD", `lm:${S}:job:logmem-google-search-setup:log`, 1792380116655, JSON.stringify({
    ts: 1792380116655,
    by: "agent:antigravity",
    kind: "progress",
    trail: "t-seo",
    summary: "Opened PR 55 for sitemap and JSON-LD baseline",
  }));
  const lm = createLogmem({ redis, space: S, surface: "test", sessionId: "s1", defaultAgent: "antigravity", compat: true });
  const recall = await call(lm, "logmem_recall", { query: "sitemap JSON-LD baseline", limit: 5 });
  assert.equal(recall.ok, true);
  assert.equal(recall.results.length, 1);
  assert.equal(recall.results[0].from, "job:logmem-google-search-setup");
  assert.deepEqual(
    recall.read_warnings?.map((w) => `${w.ref}:${w.code}`),
    ["job:client:duane:duane-lead-pipeline:read_failed"],
  );

  const jobsView = await buildView(redis, S, "jobs");
  assert.deepEqual(jobsView.jobs.map((j) => j.id), ["logmem-google-search-setup"]);
  const overview = await buildView(redis, S, "overview");
  assert.deepEqual(overview.jobs.map((j) => j.id), ["logmem-google-search-setup"]);
});

