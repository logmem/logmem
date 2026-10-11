import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore, normTs } from "../src/core/store.mjs";
import { entryFromAcmi, entryToAcmi, kindFromAcmi, normalizeKind, KINDS, TOOLS } from "../src/core/vocab.mjs";
import { parseRef } from "../src/core/keys.mjs";

test("vocab: every ACMI kind and alias maps to a LogMem word and back", () => {
  for (const [word, d] of Object.entries(KINDS)) {
    assert.deepEqual(kindFromAcmi(d.acmi), { kind: word });
    for (const a of d.also) {
      const k = kindFromAcmi(a);
      assert.equal(k.kind, word);
      assert.equal(entryToAcmi({ kind: k.kind, acmi_kind: k.acmi_kind }).kind, a, `alias ${a} survives`);
    }
  }
  assert.deepEqual(normalizeKind("test-event"), { kind: "test-event" }, "unknown kinds pass through");
  assert.equal(normalizeKind(undefined).kind, "memo");
});

test("vocab: field rename is lossless both ways", () => {
  const ev = { ts: 1, source: "agent:a", kind: "task-delegation", correlationId: "c", parentCorrelationId: "p", summary: "s", tenant_id: "t", speaker_type: "agent", payload: { x: 1 } };
  const e = entryFromAcmi(ev);
  assert.deepEqual(
    { by: e.by, trail: e.trail, origin: e.origin, space: e.space, speaker: e.speaker, kind: e.kind },
    { by: "agent:a", trail: "c", origin: "p", space: "t", speaker: "agent", kind: "handoff" },
  );
  assert.deepEqual(entryToAcmi(e), ev);
});

test("vocab: 21 logmem tools, single-word names", () => {
  assert.equal(Object.keys(TOOLS).length, 21);
  for (const n of Object.keys(TOOLS)) assert.match(n, /^logmem_[a-z]+$/);
});

test("normTs: ns, us, s all land on ms; small fixture values untouched", () => {
  const ms = 1791731538741;
  assert.equal(normTs(ms), ms);
  assert.equal(normTs(ms * 1e6), ms);
  assert.equal(normTs(ms * 1e3), ms);
  assert.equal(normTs(Math.floor(ms / 1e3)), Math.floor(ms / 1e3) * 1e3);
  assert.equal(normTs(1000), 1000);
});

test("parseRef: LogMem and ACMI namespaces", () => {
  assert.deepEqual(parseRef("thread:agent-coordination"), { ns: "channel", id: "agent-coordination" });
  assert.deepEqual(parseRef("work:issue-14"), { ns: "job", id: "issue-14" });
  assert.deepEqual(parseRef("field-notes"), { ns: "channel", id: "field-notes" });
  assert.throws(() => parseRef("job:a:b"));
});

test("store: writes go to lm:{space}:*, ts in ms, exact duplicates collapse", async () => {
  const redis = createMemoryRedis();
  const s = createStore(redis, { space: "acme" });
  const e = { ts: 1791731538741, kind: "memo", by: "agent:a", trail: "t", summary: "x" };
  await s.append("channel", "c", e);
  await s.append("channel", "c", e);
  assert.equal(await s.logSize("channel", "c"), 1);
  const keys = await redis("KEYS", "*");
  assert.ok(keys.every((k) => k.startsWith("lm:acme:")), keys.join(","));
  const [score] = (await redis("ZRANGE", "lm:acme:channel:c:log", 0, -1, "WITHSCORES")).slice(1);
  assert.equal(Number(score), 1791731538741);
});

test("store: same-ms entries keep append order", async () => {
  const s = createStore(createMemoryRedis(), { space: "acme" });
  for (const summary of ["zeta", "alpha", "mid"]) await s.append("channel", "c", { ts: 5, kind: "memo", summary });
  assert.deepEqual((await s.readLog("channel", "c")).map((e) => e.summary), ["zeta", "alpha", "mid"]);
});

test("store compat: legacy acmi:* entries (mixed s/ms/ns scores) merge in, translated", async () => {
  const redis = createMemoryRedis();
  const base = 1791700000000;
  const legacy = "acmi:madez:thread:agent-coordination:timeline";
  await redis("ZADD", legacy, base * 1e6, JSON.stringify({ ts: base * 1e6, source: "agent:old-ns", kind: "handoff-ack", correlationId: "a", summary: "ns" }));
  await redis("ZADD", legacy, Math.floor((base + 2000) / 1e3), JSON.stringify({ ts: Math.floor((base + 2000) / 1e3), source: "agent:old-s", kind: "coord-note", correlationId: "b", summary: "s" }));
  await redis("SET", "acmi:madez:agent:bentley:profile", JSON.stringify({ name: "Bentley" }));
  await redis("SADD", "acmi:madez:agent:list", "bentley");

  const s = createStore(redis, { space: "madez", compat: true });
  await s.append("channel", "agent-coordination", { ts: base + 1000, kind: "memo", by: "agent:new", trail: "c", summary: "ms" });
  const log = await s.readLog("channel", "agent-coordination");
  assert.deepEqual(log.map((e) => e.summary), ["ns", "ms", "s"]);
  assert.deepEqual(log.map((e) => e.kind), ["accepted", "memo", "memo"]);
  assert.equal(log[0].by, "agent:old-ns");
  assert.equal(log[0].trail, "a");
  assert.ok(log.every((e) => String(e.ts).length === 13), "all ms");
  assert.deepEqual(await s.getWho("agent", "bentley"), { name: "Bentley" });
  assert.deepEqual(await s.list("agent"), ["bentley"]);

  const strict = createStore(redis, { space: "madez" });
  assert.equal((await strict.readLog("channel", "agent-coordination")).length, 1, "compat off: lm only");
});

test("store.remove: dry run by default, refuses other spaces and protected keys", async () => {
  const redis = createMemoryRedis();
  const s = createStore(redis, { space: "acme" });
  await s.append("channel", "c", { kind: "memo", summary: "x" });
  const key = "lm:acme:channel:c:log";
  assert.equal((await s.remove(key)).dry_run, true);
  assert.equal(await s.logSize("channel", "c"), 1);
  await assert.rejects(s.remove("lm:other:channel:c:log"), /this space only/);
  await assert.rejects(s.remove("lm:acme:session:x"), /protected/);
  await assert.rejects(s.remove("acmi:acme:thread:c:timeline"), /this space only/);
  assert.equal((await s.remove(key, { confirm: true })).removed, true);
});
