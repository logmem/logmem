// decide-resign.test.mjs: re-signing pre-swap decisions after a LOGMEM_DECIDE_SECRET swap.
// Job decide-resign-migration (plan decide-key-recovery).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "./space-context.mjs";
import { createStore } from "../src/core/store.mjs";
import { writeDecision } from "../src/core/tools.mjs";
import { lmDecisionKey } from "../src/core/keys.mjs";
import { resignDecisions, summarizeResign, ResignError } from "../src/core/decide-resign.mjs";

const OLD = "old-decide-key-0123456789abcdef-old";
const NEW = "new-decide-key-fedcba9876543210-new-0123456789abcdef";
const SPACE = "fieldnotes";
const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

function clock(start = 1791712800000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

async function team() {
  const redis = createMemoryRedis();
  const now = clock();
  const q = createLogmem({ workRules: "warn", redis, space: SPACE, surface: "codex", sessionId: "quill-s", now });
  await sc(q, "logmem_start", { agent: "quill" });
  await sc(q, "logmem_assign", { job: "issue-14", title: "Issue 14" });
  return { redis, q, now, store: createStore(redis, { space: SPACE }) };
}

async function askAndDecide(t, { verdict = "approve", n = 1 } = {}) {
  t.now.advance(1000);
  const ask = await sc(t.q, "logmem_ask", { question: `Ship change ${n}?`, action: `Merge PR ${n}`, where: "job:issue-14", to: "human:mikey" });
  assert.equal(ask.ok, true, JSON.stringify(ask));
  t.now.advance(1000);
  await writeDecision(t.store, ask.trail, { verdict, by: "human:mikey", confirm: true, secret: OLD, now: t.now });
  return ask.trail;
}

const pending = async (t) => (await sc(t.q, "logmem_brief", {})).pending_asks.length;

test("decide-resign: a swap re-opens decided asks, and a re-sign closes them again", async (t0) => {
  const t = await team();
  const trails = [await askAndDecide(t, { n: 1 }), await askAndDecide(t, { n: 2, verdict: "reject" })];
  process.env.LOGMEM_DECIDE_SECRET = OLD;
  assert.equal(await pending(t), 0, "both decided under the old key");
  process.env.LOGMEM_DECIDE_SECRET = NEW;
  t0.after(() => delete process.env.LOGMEM_DECIDE_SECRET);
  assert.equal(await pending(t), 2, "the swap makes them pending again");

  const cutoff = t.now() + 1;
  const dry = await resignDecisions(t.store, { oldSecret: OLD, newSecret: NEW, cutoff });
  assert.equal(summarizeResign(dry).resigned, 2);
  assert.equal(await pending(t), 2, "a dry run writes nothing");

  const run = await resignDecisions(t.store, { oldSecret: OLD, newSecret: NEW, cutoff, apply: true });
  assert.deepEqual(run.resigned.sort(), [...trails].sort());
  assert.equal(await pending(t), 0, "re-signed decisions count again under the new key");
  const brief = await sc(t.q, "logmem_brief", {});
  assert.deepEqual(brief.answered_asks.map((a) => a.verdict).sort(), ["approve", "reject"], "verdicts kept");

  const again = await resignDecisions(t.store, { oldSecret: OLD, newSecret: NEW, cutoff, apply: true });
  assert.equal(again.already_valid.length, 2, "a second run changes nothing");
  assert.equal(again.resigned.length, 0);
});

test("decide-resign: a decision made after the cutoff is not migrated", async () => {
  const t = await team();
  const cutoff = t.now(); // before the decision below
  await askAndDecide(t);
  const r = await resignDecisions(t.store, { oldSecret: OLD, newSecret: NEW, cutoff, apply: true });
  assert.equal(r.after_cutoff.length, 1);
  assert.equal(r.resigned.length, 0);
});

test("decide-resign: a decision that does not verify under the old key is left alone", async () => {
  const t = await team();
  const trail = await askAndDecide(t);
  const other = "a-different-old-key-that-signed-nothing-here";
  const r = await resignDecisions(t.store, { oldSecret: other, newSecret: NEW, cutoff: t.now() + 1, apply: true });
  assert.deepEqual(r.unverifiable, [trail]);
  const raw = JSON.parse(await t.redis("GET", lmDecisionKey(SPACE, trail)));
  assert.notEqual(raw.sig, undefined);
  assert.equal(r.resigned.length, 0);
});

test("decide-resign: an ask altered after it was signed is never migrated", async () => {
  const t = await team();
  const trail = await askAndDecide(t);
  // Swap the ask's action in the store, as a tamper would.
  for (const k of t.redis._data.keys()) {
    if (!k.endsWith(":log")) continue;
    const flat = await t.redis("ZRANGE", k, 0, -1, "WITHSCORES");
    for (let i = 0; i < flat.length; i += 2) {
      const [m, score] = [flat[i], flat[i + 1]];
      const e = JSON.parse(m);
      if (e.kind === "approval" && e.trail === trail) {
        await t.redis("ZREM", k, m);
        await t.redis("ZADD", k, score, JSON.stringify({ ...e, action: "Delete production" }));
      }
    }
  }
  const r = await resignDecisions(t.store, { oldSecret: OLD, newSecret: NEW, cutoff: t.now() + 1, apply: true });
  assert.deepEqual(r.altered, [trail]);
  assert.equal(r.resigned.length, 0);
});

test("decide-resign: a decision kept only in the logs gets a new claim", async (t0) => {
  const t = await team();
  const trail = await askAndDecide(t);
  await t.redis("DEL", lmDecisionKey(SPACE, trail));
  const r = await resignDecisions(t.store, { oldSecret: OLD, newSecret: NEW, cutoff: t.now() + 1, apply: true });
  assert.deepEqual(r.resigned, [trail]);
  process.env.LOGMEM_DECIDE_SECRET = NEW;
  t0.after(() => delete process.env.LOGMEM_DECIDE_SECRET);
  assert.equal(await pending(t), 0);
});

test("decide-resign: a defer is never turned into a settled answer", async () => {
  const t = await team();
  const trail = await askAndDecide(t, { verdict: "defer" });
  const r = await resignDecisions(t.store, { oldSecret: OLD, newSecret: NEW, cutoff: t.now() + 1, apply: true });
  assert.deepEqual(r.defer_only, [trail]);
  assert.equal(await t.redis("GET", lmDecisionKey(SPACE, trail)), null);
});

test("decide-resign: refuses bad keys and a missing cutoff, and the summary carries no secrets", async () => {
  const t = await team();
  await assert.rejects(resignDecisions(t.store, { oldSecret: "short", newSecret: NEW, cutoff: 1 }), ResignError);
  await assert.rejects(resignDecisions(t.store, { oldSecret: OLD, newSecret: OLD, cutoff: 1 }), ResignError);
  await assert.rejects(resignDecisions(t.store, { oldSecret: OLD, newSecret: NEW }), ResignError);
  await assert.rejects(
    resignDecisions(t.store, {
      oldSecret: OLD,
      newSecret: NEW,
      verifyUrl: "https://example.test/api/verify-decisions",
      cutoff: 1,
    }),
    ResignError,
  );
  await askAndDecide(t);
  const s = JSON.stringify(summarizeResign(await resignDecisions(t.store, { oldSecret: OLD, newSecret: NEW, cutoff: t.now() + 1 })));
  assert.ok(!s.includes(OLD) && !s.includes(NEW));
  assert.doesNotMatch(s, /[0-9a-f]{64}/, "no signatures");
});

test("decide-resign: --verify-url oracle re-signs without the old key", async (t0) => {
  const t = await team();
  const trails = [await askAndDecide(t, { n: 1 }), await askAndDecide(t, { n: 2, verdict: "reject" })];
  process.env.LOGMEM_DECIDE_SECRET = NEW;
  t0.after(() => delete process.env.LOGMEM_DECIDE_SECRET);
  assert.equal(await pending(t), 2);

  // Oracle answers with the old-key truth: every posted decision verifies.
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return { valid: body.decisions.map((_, i) => i) };
      },
    };
  };

  const dry = await resignDecisions(t.store, {
    newSecret: NEW,
    verifyUrl: "https://pre-swap.test/api/verify-decisions",
    fetchImpl,
    cutoff: t.now() + 1,
  });
  assert.equal(dry.verifier, "verify-url");
  assert.equal(summarizeResign(dry).resigned, 2);
  assert.equal(await pending(t), 2, "dry run writes nothing");

  const run = await resignDecisions(t.store, {
    newSecret: NEW,
    verifyUrl: "https://pre-swap.test/api/verify-decisions",
    fetchImpl,
    cutoff: t.now() + 1,
    apply: true,
  });
  assert.deepEqual(run.resigned.sort(), [...trails].sort());
  assert.equal(await pending(t), 0);
});

test("decide-resign: oracle that verifies nothing leaves decisions unverifiable", async () => {
  const t = await team();
  const trail = await askAndDecide(t);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { valid: [] };
    },
  });
  const r = await resignDecisions(t.store, {
    newSecret: NEW,
    verifyUrl: "https://pre-swap.test/api/verify-decisions",
    fetchImpl,
    cutoff: t.now() + 1,
    apply: true,
  });
  assert.deepEqual(r.unverifiable, [trail]);
  assert.equal(r.resigned.length, 0);
});
