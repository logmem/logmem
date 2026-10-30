// review-pr10.test.mjs — decision-integrity follow-up (cid logmemPr10Review-20261012d).
// These suites test decision integrity, not where work lives: they run with
// workRules "warn" so asks may sit on an agent log (see test/work-model.test.mjs).
// The signature binds the ask, shadows and conflicting copies are refused,
// another agent's slots and handoff settlements cannot be forged, the job
// page uses the server's settled-ask rule, and a failed append or a key
// rotation can be recovered. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore } from "../src/core/store.mjs";
import {
  writeDecision,
  DecisionError,
  signDecision,
  verifyDecision,
  findAsk,
  HANDOFF_ONLY,
  HANDOFF_WRITE_ONLY,
  DECLINED_TYPE,
  isDeclined,
} from "../src/core/tools.mjs";
import { lmDecisionKey, lmSessionKey } from "../src/core/keys.mjs";
import { createShifts } from "../src/core/session.mjs";
import { decide } from "../api/decide.mjs";
import inbox from "../api/inbox/[agent].mjs";
import { buildView } from "../src/http/view.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";

process.env.LOGMEM_DECIDE_SECRET ||= "test-only-decide-key-0123456789abcdef";
const SECRET = "test-only-decide-key-0123456789abcdef";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;
const isCode = (code) => (e) => e instanceof DecisionError && e.code === code;

function clock(start = 1791712800000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

async function team({ compat = false, now } = {}) {
  const redis = createMemoryRedis();
  const mk = (sid) => createLogmem({ workRules: "warn", redis, space: "fieldnotes", surface: "codex", sessionId: sid, compat, ...(now ? { now } : {}) });
  const a = mk("atlas-s");
  const q = mk("quill-s");
  await sc(a, "logmem_start", { agent: "atlas" });
  await sc(q, "logmem_start", { agent: "quill" });
  return { redis, a, q, store: createStore(redis, { space: "fieldnotes" }) };
}

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.setHeader = (k, v) => ((r.headers[k.toLowerCase()] = v), r);
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (o) => ((r.body = o), r);
  r.end = () => r;
  return r;
}

async function decidedRows(redis) {
  const out = [];
  for (const k of redis._data.keys()) {
    if (!k.endsWith(":log")) continue;
    for (const m of await redis("ZRANGE", k, 0, -1)) {
      const e = JSON.parse(m);
      if (e.kind === "decided") out.push({ k, e });
    }
  }
  return out;
}

/** Rewrite approval copies of `trail` in place (optionally one log key). */
async function rewriteApprovals(redis, trail, mutate, { key } = {}) {
  let n = 0;
  for (const k of [...redis._data.keys()]) {
    if (key && k !== key) continue;
    if (!String(k).endsWith(":log")) continue;
    const flat = await redis("ZRANGE", k, 0, -1, "WITHSCORES");
    for (let i = 0; i < flat.length; i += 2) {
      let parsed;
      try {
        parsed = JSON.parse(flat[i]);
      } catch {
        continue;
      }
      if (parsed.kind !== "approval" || parsed.trail !== trail) continue;
      const { _o, ...rest } = parsed;
      const next = mutate(rest);
      await redis("ZREM", k, flat[i]);
      await redis("ZADD", k, Number(flat[i + 1]), JSON.stringify(_o !== undefined ? { _o, ...next } : next));
      n++;
    }
  }
  return n;
}

async function dropDecided(redis) {
  for (const k of [...redis._data.keys()]) {
    if (!String(k).endsWith(":log")) continue;
    for (const m of await redis("ZRANGE", k, 0, -1)) {
      if (JSON.parse(m).kind === "decided") await redis("ZREM", k, m);
    }
  }
}

// ─── High 1: the signature binds the ask ────────────────────────────────
test("high 1: verifyDecision fails when any bound ask field changes", async () => {
  const { q, store } = await team();
  await sc(q, "logmem_assign", { job: "issue-14", title: "Issue 14" });
  const ask = await sc(q, "logmem_ask", {
    question: "Send issue 14?",
    action: "POST /send",
    reversible: true,
    where: "job:issue-14",
    to: "human:mikey",
  });
  const real = await writeDecision(store, ask.trail, { verdict: "approve", by: "human:mikey", secret: SECRET });
  const opts = { secret: SECRET, space: "fieldnotes" };
  assert.equal(verifyDecision(real.entry, { ...opts, ask: ask.entry }), true);
  const flips = {
    action: { ...ask.entry, action: "POST /wipe" },
    question: { ...ask.entry, summary: "Delete issue 14?" },
    reversible: { ...ask.entry, reversible: false },
    to: { ...ask.entry, to: "human:avery" },
    where: { ...ask.entry, where: "job:other" },
    by: { ...ask.entry, by: "agent:atlas" },
    trail: { ...ask.entry, trail: "someone-elses-trail" },
  };
  for (const [field, altered] of Object.entries(flips)) {
    assert.equal(verifyDecision(real.entry, { ...opts, ask: altered }), false, field);
  }
});

test("high 1: findAsk is deterministic and refuses a shadow approval on another agent", async () => {
  const { store } = await team();
  // A trail with no embedded timestamp is read in full, so an earlier copy is visible.
  const base = { kind: "approval", by: "agent:quill", summary: "Pay?", action: "pay inv-9", reversible: true, where: "agent:quill", trail: "ask-plain", status: "waiting" };
  await store.append("agent", "quill", { ...base, ts: 200 });
  await store.append("agent", "quill", { ...base, ts: 100 });
  const found = await findAsk(store, "ask-plain");
  assert.equal(found.ask.ts, 100, "the earliest own copy wins");
  assert.equal(found.asker, "quill");

  // "aaa" sorts before "quill". A first-hit finder would treat this shadow as the ask.
  await store.append("agent", "aaa", { ...base, ts: 50 });
  await assert.rejects(() => findAsk(store, "ask-plain"), (e) => isCode("ambiguous")(e) && /aaa/.test(e.message));
  await assert.rejects(() => writeDecision(store, "ask-plain", { verdict: "approve", by: "human:mikey", secret: SECRET }), isCode("ambiguous"));
  assert.equal(await store.redis("EXISTS", lmDecisionKey("fieldnotes", "ask-plain")), 0, "no settlement claimed");
});

test("high 1: conflicting copies are refused, and flipping reversible after a decision does not re-sign", async () => {
  const { q, store, redis } = await team();
  await sc(q, "logmem_assign", { job: "issue-14", title: "Issue 14" });
  const ask = await sc(q, "logmem_ask", { question: "Send?", action: "POST /send", reversible: true, where: "job:issue-14" });
  assert.equal(await rewriteApprovals(redis, ask.trail, (e) => ({ ...e, reversible: false }), { key: "lm:fieldnotes:job:issue-14:log" }), 1);
  await assert.rejects(
    () => writeDecision(store, ask.trail, { verdict: "approve", by: "human:mikey", secret: SECRET }),
    (e) => isCode("ambiguous")(e) && /conflicting/.test(e.message),
  );
  assert.equal(await redis("EXISTS", lmDecisionKey("fieldnotes", ask.trail)), 0);

  await rewriteApprovals(redis, ask.trail, (e) => ({ ...e, reversible: true }), { key: "lm:fieldnotes:job:issue-14:log" });
  const real = await writeDecision(store, ask.trail, { verdict: "approve", by: "human:mikey", secret: SECRET });
  assert.equal(real.ok, true);
  const before = await redis("GET", lmDecisionKey("fieldnotes", ask.trail));
  assert.equal(await rewriteApprovals(redis, ask.trail, (e) => ({ ...e, reversible: false, question: "Send?", summary: "Send?" })), 2);
  let brief = await sc(q, "logmem_brief", {});
  assert.deepEqual(brief.pending_asks.map((x) => x.trail), [ask.trail], "altered ask is pending again");
  assert.equal(brief.answered_asks.length, 0);
  await assert.rejects(
    () => writeDecision(store, ask.trail, { verdict: "reject", by: "human:mikey", secret: SECRET, reclaim: true }),
    (e) => isCode("not_pending")(e) && /altered after it was signed/.test(e.message),
  );
  assert.equal(await redis("GET", lmDecisionKey("fieldnotes", ask.trail)), before, "the old signature was not replaced");
});

// ─── High 2: onlyMe, handoff settlement, signed logs ────────────────────
test("high 2: remove and acmi_delete refuse another agent's who/log/profile; a signed log is never removed", async () => {
  const { a, q, store, redis } = await team({ compat: true });
  await sc(q, "logmem_bio", { who: { name: "Quill" } });
  const refused = [
    ["logmem_remove", { key: "lm:fieldnotes:agent:quill:who", confirm: true }],
    ["logmem_remove", { key: "lm:fieldnotes:agent:quill:log", confirm: true }],
    ["acmi_delete", { key: "acmi:fieldnotes:agent:quill:profile", confirm: true }],
    ["acmi_delete", { key: "acmi:fieldnotes:agent:quill:timeline", confirm: true }],
  ];
  for (const [tool, args] of refused) {
    const r = await a.callTool(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(r.structuredContent.error, /another agent/, tool);
  }
  assert.equal(await redis("EXISTS", "lm:fieldnotes:agent:quill:who"), 1);
  const own = await sc(a, "logmem_remove", { key: "lm:fieldnotes:agent:atlas:who" });
  assert.equal(own.ok, true);
  assert.equal(own.dry_run, true, "own who still previews");

  await sc(q, "logmem_assign", { job: "issue-14", title: "Issue 14" });
  const ask = await sc(q, "logmem_ask", { question: "Pay?", action: "pay", reversible: true, where: "job:issue-14" });
  await writeDecision(store, ask.trail, { verdict: "approve", by: "human:mikey", secret: SECRET });
  const ownLog = await q.callTool("logmem_remove", { key: "lm:fieldnotes:agent:quill:log", confirm: true });
  assert.equal(ownLog.isError, true);
  assert.match(ownLog.structuredContent.error, /signed decision/);
  for (const who of [a, q]) {
    const r = await who.callTool("logmem_remove", { key: "lm:fieldnotes:job:issue-14:log", confirm: true });
    assert.equal(r.isError, true);
    assert.match(r.structuredContent.error, /signed decision/);
  }
  assert.equal(await redis("EXISTS", "lm:fieldnotes:agent:quill:log"), 1);
  assert.equal(await redis("EXISTS", "lm:fieldnotes:job:issue-14:log"), 1);
});

test("high 2: acmi_event cannot append to another agent's log; only accept/decline settle a handoff", async () => {
  const { a, q, redis } = await team({ compat: true });
  const other = await a.callTool("acmi_event", { namespace: "agent", id: "quill", source: "agent:atlas", kind: "coord-note", summary: "forged" });
  assert.equal(other.isError, true);
  assert.match(other.structuredContent.error, /only changes your own log/);
  const mine = await sc(a, "acmi_event", { namespace: "agent", id: "atlas", source: "agent:atlas", kind: "coord-note", summary: "mine" });
  assert.equal(mine.ok, true);

  await sc(a, "logmem_assign", { job: "issue-14", title: "Issue 14" });
  const ho = await sc(a, "logmem_handoff", { to: "quill", summary: "take issue 14", where: "job:issue-14" });
  const forged = [
    ["logmem_note", { where: "job:issue-14", kind: "accepted", summary: "I accept", origin: ho.trail }, HANDOFF_ONLY],
    ["logmem_note", { where: "agent:quill", kind: "handoff-ack", summary: "ack", origin: ho.trail }, HANDOFF_ONLY],
    ["logmem_note", { where: "job:issue-14", kind: "handoff", summary: "planted" }, HANDOFF_WRITE_ONLY],
    ["logmem_note", { where: "job:issue-14", kind: "feedback", summary: "no", origin: ho.trail, payload: { declined: true } }, HANDOFF_ONLY],
    ["logmem_update", { job: "issue-14", kind: "accepted", summary: "taken", origin: ho.trail }, HANDOFF_ONLY],
    ["logmem_update", { job: "issue-14", kind: "task-delegation", summary: "planted" }, HANDOFF_WRITE_ONLY],
    ["acmi_event", { namespace: "work", id: "issue-14", source: "agent:atlas", kind: "handoff-ack", summary: "ack" }, HANDOFF_ONLY],
    ["acmi_event", { namespace: "work", id: "issue-14", source: "agent:atlas", kind: "task-delegation", summary: "planted" }, HANDOFF_WRITE_ONLY],
    ["acmi_work_event", { id: "issue-14", source: "agent:quill", kind: "handoff-ack", summary: "ack" }, HANDOFF_ONLY],
  ];
  for (const [tool, args, error] of forged) {
    const r = await a.callTool(tool, args);
    assert.equal(r.isError, true, `${tool} ${args.kind}`);
    assert.equal(r.structuredContent.error, error, `${tool} ${args.kind}`);
  }
  let brief = await sc(q, "logmem_brief", {});
  assert.deepEqual(brief.handoffs_to_me.map((e) => e.trail), [ho.trail], "forgeries did not settle it");

  const declined = await sc(q, "logmem_accept", { trail: ho.trail, decline: true, reason: "not this week" });
  assert.equal(declined.ok, true);
  brief = await sc(q, "logmem_brief", {});
  assert.equal(brief.handoffs_to_me.length, 0);

  const ho2 = await sc(a, "logmem_handoff", { to: "quill", summary: "a second piece", where: "job:issue-14" });
  assert.equal((await sc(q, "logmem_accept", { trail: ho2.trail })).ok, true);
  assert.ok((await redis("ZRANGE", "lm:fieldnotes:job:issue-14:log", 0, -1)).some((m) => JSON.parse(m).kind === "accepted"));
});

test("high b: non-boolean payload.declined does not settle a handoff", async () => {
  const { a, q, store, redis } = await team();
  await sc(a, "logmem_assign", { job: "issue-14", title: "Issue 14" });
  const ho = await sc(a, "logmem_handoff", { to: "quill", summary: "take issue 14", where: "job:issue-14" });
  assert.equal(isDeclined({ declined: true }), true);
  assert.equal(isDeclined({ declined: false }), false);
  assert.equal(isDeclined(null), false);
  assert.equal(isDeclined(undefined), false);
  const bad = [1, [], "yes", "true"];
  for (const declined of bad) {
    assert.equal(isDeclined({ declined }), false, JSON.stringify(declined));
    for (const where of ["agent:quill", "job:issue-14"]) {
      const note = await a.callTool("logmem_note", {
        where,
        kind: "feedback",
        summary: "no",
        origin: ho.trail,
        payload: { declined },
      });
      assert.equal(note.isError, true, `${where} ${JSON.stringify(declined)}`);
      assert.equal(note.structuredContent.error, DECLINED_TYPE, `${where} ${JSON.stringify(declined)}`);
    }
  }
  const memo = await a.callTool("logmem_note", {
    where: "channel:ops",
    kind: "memo",
    summary: "aside",
    payload: { declined: "true" },
  });
  assert.equal(memo.isError, true);
  assert.equal(memo.structuredContent.error, DECLINED_TYPE, "non-boolean declined is refused on any kind");

  const stillTrue = await a.callTool("logmem_note", {
    where: "agent:quill",
    kind: "feedback",
    summary: "no",
    origin: ho.trail,
    payload: { declined: true },
  });
  assert.equal(stillTrue.isError, true);
  assert.equal(stillTrue.structuredContent.error, HANDOFF_ONLY, "boolean true stays on the accept-only guard");

  const ordinary = await sc(q, "logmem_note", {
    where: "agent:quill",
    kind: "feedback",
    summary: "not a decline",
    origin: ho.trail,
    payload: { declined: false, note: "thinking" },
  });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.entry.payload.declined, false);

  let brief = await sc(q, "logmem_brief", {});
  assert.deepEqual(brief.handoffs_to_me.map((e) => e.trail), [ho.trail], "refused notes did not clear it");

  // A row that skipped the write guard (already stored) is still not a decline.
  let ts = 1;
  for (const declined of bad) {
    await store.append("agent", "quill", {
      ts: ts++,
      kind: "feedback",
      origin: ho.trail,
      by: "agent:atlas",
      summary: "forged",
      payload: { declined },
    });
  }
  brief = await sc(q, "logmem_brief", {});
  assert.deepEqual(brief.handoffs_to_me.map((e) => e.trail), [ho.trail], "stored 1, [], yes, and \"true\" do not clear the brief");
  const view = await buildView(redis, "fieldnotes", "agent", { id: "quill" });
  assert.ok(view.handoffs.some((e) => e.trail === ho.trail), "agent view still lists the handoff");

  const declined = await sc(q, "logmem_accept", { trail: ho.trail, decline: true, reason: "not this week" });
  assert.equal(declined.ok, true, "accept does not treat the forgeries as already declined");
  assert.equal(declined.entries.every((e) => e.payload.declined === true), true);
  assert.equal((await sc(q, "logmem_brief", {})).handoffs_to_me.length, 0, "a real decline still clears the brief");
  const after = await buildView(redis, "fieldnotes", "agent", { id: "quill" });
  assert.equal(after.handoffs.some((e) => e.trail === ho.trail), false, "a real decline still clears the agent view");
});

test("high 2: dropping signed decided rows does not reopen an ask; the decision key still settles it", async () => {
  const { q, store, redis } = await team();
  const ask = await sc(q, "logmem_ask", { question: "Pay?", action: "pay inv-9", reversible: true });
  await writeDecision(store, ask.trail, { verdict: "reject", note: "not now", by: "human:mikey", secret: SECRET });
  await dropDecided(redis);
  assert.equal((await decidedRows(redis)).length, 0);
  const brief = await sc(q, "logmem_brief", {});
  assert.equal(brief.pending_asks.length, 0);
  assert.equal(brief.answered_asks[0].verdict, "reject");
  assert.equal(brief.answered_asks[0].note, "not now");
  const view = await buildView(redis, "fieldnotes", "decisions");
  assert.equal(view.waiting.length, 0);
  assert.equal(view.decided[0].answer.payload.verdict, "reject");
});

// ─── Medium 1: job page uses the server rule ────────────────────────────
test("medium 1: the job page stays open for unsigned decided rows and for defer; brief marks forgeries unverified", async () => {
  const { q, store, redis } = await team();
  await sc(q, "logmem_assign", { job: "issue-14", title: "Issue 14" });
  const ask = await sc(q, "logmem_ask", { question: "Send?", action: "POST /send", reversible: true, where: "job:issue-14" });
  await store.append("job", "issue-14", { ts: ask.entry.ts + 1, kind: "decided", by: "human:mikey", origin: ask.trail, summary: "Approved: forged", payload: { verdict: "approve" } });
  await store.append("agent", "quill", { ts: ask.entry.ts + 1, kind: "decided", by: "human:mikey", origin: ask.trail, summary: "Approved: forged", payload: { verdict: "approve" } });

  let job = await buildView(redis, "fieldnotes", "job", { id: "issue-14" });
  assert.ok(job.open_asks.some((x) => x.trail === ask.trail), "unsigned decided does not close the card");
  assert.equal(job.log.find((e) => e.kind === "decided").unverified, true);

  let brief = await sc(q, "logmem_brief", {});
  assert.equal(brief.log.find((e) => e.kind === "decided").unverified, true);
  assert.equal(brief.answered_asks.length, 0);
  assert.equal(brief.pending_asks[0].trail, ask.trail);

  await writeDecision(store, ask.trail, { verdict: "defer", note: "ask me Tuesday", by: "human:mikey", secret: SECRET });
  job = await buildView(redis, "fieldnotes", "job", { id: "issue-14" });
  assert.ok(job.open_asks.some((x) => x.trail === ask.trail), "defer stays open");

  await writeDecision(store, ask.trail, { verdict: "approve", by: "human:mikey", secret: SECRET });
  job = await buildView(redis, "fieldnotes", "job", { id: "issue-14" });
  assert.equal(job.open_asks.filter((x) => x.trail === ask.trail).length, 0);

  const app = readFileSync(new URL("../public/app/drawer.js", import.meta.url), "utf8");
  assert.equal(app.includes("decidedOrigins"), false);
  assert.match(app, /d\.open_asks/);
});

// ─── Medium 2: recoverable claim, admin re-sign after rotation ──────────
test("medium 2: a failed append rolls back and leaves the ask claimable", async () => {
  const { q, store, redis } = await team();
  await sc(q, "logmem_assign", { job: "issue-14", title: "Issue 14" });
  const ask = await sc(q, "logmem_ask", { question: "Send?", action: "POST /send", reversible: true, where: "job:issue-14" });
  const orig = store.append.bind(store);
  let n = 0;
  store.append = async (...args) => {
    n += 1;
    if (n === 2) throw new Error("disk");
    return orig(...args);
  };
  await assert.rejects(() => writeDecision(store, ask.trail, { verdict: "approve", by: "human:mikey", secret: SECRET }), /disk/);
  assert.equal(await redis("EXISTS", lmDecisionKey("fieldnotes", ask.trail)), 0);
  assert.equal((await decidedRows(redis)).length, 0, "the job row was rolled back");
  store.append = orig;
  const out = await writeDecision(store, ask.trail, { verdict: "approve", by: "human:mikey", secret: SECRET });
  assert.equal(out.ok, true);
  assert.equal((await sc(q, "logmem_brief", {})).answered_asks[0].verdict, "approve");
});

test("medium 2: rotation does not verify until an admin re-answer; an altered ask is not migrated", async () => {
  const { q, store, redis } = await team();
  const ask = await sc(q, "logmem_ask", { question: "Pay?", action: "pay inv-9", reversible: true });
  const OLD = "old-decide-secret-0123456789abcdef";
  const NEW = "new-decide-secret-0123456789abcdef";
  const saved = process.env.LOGMEM_DECIDE_SECRET;
  process.env.LOGMEM_DECIDE_SECRET = OLD;
  try {
    await writeDecision(store, ask.trail, { verdict: "approve", by: "human:admin" });
    process.env.LOGMEM_DECIDE_SECRET = NEW;
    await assert.rejects(
      () => writeDecision(store, ask.trail, { verdict: "reject", by: "human:admin" }),
      (e) => isCode("not_pending")(e) && /does not verify under the current/.test(e.message),
    );
    assert.equal((await decidedRows(redis)).length, 1, "the failed re-answer kept nothing new");
    assert.equal(JSON.parse(await redis("GET", lmDecisionKey("fieldnotes", ask.trail))).verdict, "approve");

    const env = { LOGMEM_ADMIN_PASSWORD: "correct horse", VERCEL_ENV: "production", LOGMEM_VIEW_SPACES: "fieldnotes", LOGMEM_ADMIN_ID: "admin" };
    const cookie = issueCookie(env).split(";")[0];
    const res = mockRes();
    await decide(
      { method: "POST", headers: { host: "h", origin: "https://h", cookie, "x-logmem-intent": "decide" }, body: { space: "fieldnotes", trail: ask.trail, verdict: "reject", note: "migrated" } },
      res,
      { env, redis },
    );
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.reclaimed, true);
    assert.equal(JSON.parse(await redis("GET", lmDecisionKey("fieldnotes", ask.trail))).verdict, "reject");
    const brief = await sc(q, "logmem_brief", {});
    assert.equal(brief.answered_asks[0].verdict, "reject");
  } finally {
    process.env.LOGMEM_DECIDE_SECRET = saved;
  }
});

// ─── Low: resumed shift id, caller-chosen trails ────────────────────────
test("low: a resumed shift with an invalid agent id is dropped, not recapped", async () => {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: "fieldnotes" });
  const shifts = createShifts(store, { sessionId: "s1", surface: "codex" });
  await shifts.start("quill");
  const key = lmSessionKey("fieldnotes", "s1");
  const rec = JSON.parse(await redis("GET", key));
  rec.agent = "not a valid id";
  rec.last_seen = 1;
  await redis("SET", key, JSON.stringify(rec));
  await assert.rejects(() => shifts.recap({ notes: "stolen" }), /no open shift/);
  assert.equal(await shifts.sweep(), false);
  assert.equal((await store.readLog("agent", "quill")).some((e) => e.kind === "recap"), false);
  const touched = await shifts.touch("logmem_brief");
  assert.equal(touched.shift.agent, "codex");
  assert.equal(touched.events[0].type, "auto-start");
  const ids = await store.list("agent");
  assert.equal(ids.includes("not a valid id"), false);
  assert.equal(ids.includes("codex"), true);
});

test("low: a caller-chosen trail already on the receiver or inbox agent is refused", async () => {
  const { a, q } = await team();
  assert.equal((await sc(a, "logmem_note", { where: "agent:quill", summary: "already here", trail: "taken-1" })).ok, true);
  const ho = await sc(a, "logmem_handoff", { to: "quill", summary: "same trail", trail: "taken-1" });
  assert.equal(ho.ok, false);
  assert.match(ho.error, /already used on quill/);
  assert.equal((await sc(a, "logmem_handoff", { to: "quill", summary: "fresh trail" })).ok, true);
  assert.equal((await sc(q, "logmem_brief", {})).handoffs_to_me.length, 1);

  const redis = createMemoryRedis();
  globalThis.__lmDevRedis = redis;
  try {
    const req = (body) => ({
      method: "POST",
      url: "/api/inbox/quill",
      query: { agent: "quill" },
      headers: { host: "x", "x-logmem-rest-url": "memory://test", "x-logmem-rest-token": "t", "x-logmem-space": "acme" },
      body,
    });
    const run = async (body) => {
      const res = mockRes();
      await inbox(req(body), res);
      return res;
    };
    assert.equal((await run({ summary: "first", trail: "inbox-1" })).statusCode, 201);
    const again = await run({ summary: "second", trail: "inbox-1" });
    assert.equal(again.statusCode, 409);
    assert.match(again.body.error, /already used/);
    assert.equal((await run({ summary: "third" })).statusCode, 201, "omitting trail still mints one");
  } finally {
    delete globalThis.__lmDevRedis;
  }
});

test("high 1: signDecision covers the ask binding (v2)", () => {
  const ask = { action: "pay", summary: "Pay?", reversible: true, to: null, where: "agent:quill", trail: "t-1", by: "agent:quill" };
  const fields = { space: "fieldnotes", origin: "t-1", verdict: "approve", note: null, by: "human:mikey", ts: 5, ask };
  const sig = signDecision(fields, SECRET);
  const entry = { kind: "decided", origin: "t-1", by: "human:mikey", ts: 5, payload: { verdict: "approve", note: null, sig } };
  assert.equal(verifyDecision(entry, { secret: SECRET, space: "fieldnotes", ask }), true);
  assert.equal(verifyDecision(entry, { secret: SECRET, space: "fieldnotes", ask: { ...ask, action: "refund" } }), false);
});

test("agent view: reads up to 200 entries to align handoffs window with the brief", async () => {
  const { a, q, redis } = await team();
  // Quill writes 60 notes
  for (let i = 0; i < 60; i++) {
    await sc(q, "logmem_note", { text: `warmup note ${i}` });
  }
  const ho = await sc(a, "logmem_handoff", {
    to: "quill",
    summary: "review docs",
    trail: "ho-limit-test-1",
  });
  assert.equal(ho.ok, true);

  // Quill has 60 notes + 1 handoff = 61 entries.
  // With limit: 50, view would truncate and miss the handoff entirely.
  // With limit: 200, view sees it as pending.
  let view = await buildView(redis, "fieldnotes", "agent", { id: "quill" });
  assert.ok(view.handoffs.some((e) => e.trail === ho.trail), "agent view sees handoff within 200 entries");

  // Quill accepts the handoff
  const accepted = await sc(q, "logmem_accept", { trail: ho.trail });
  assert.equal(accepted.ok, true);

  // Quill logs 60 subsequent notes; total entries > 120
  for (let i = 0; i < 60; i++) {
    await sc(q, "logmem_note", { text: `post-accept note ${i}` });
  }

  // With limit: 200, acceptance and handoff are both within the 200 window, so handoff is settled
  view = await buildView(redis, "fieldnotes", "agent", { id: "quill" });
  assert.equal(view.handoffs.some((e) => e.trail === ho.trail), false, "settled handoff remains cleared within 200-entry window");
});
