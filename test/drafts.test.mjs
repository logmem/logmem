// drafts.test.mjs — Phase 0 foundations for Ask the record / approach C.
// Design §14 cases 3–9 (no model). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore } from "../src/core/store.mjs";
import { lmAskKey, lmDraftKey } from "../src/core/keys.mjs";
import {
  createDraft,
  getDraft,
  listDrafts,
  discardDraft,
  markDraftSent,
  DRAFT_TTL_S,
  DraftError,
} from "../src/core/drafts.mjs";
import { insufficientScope } from "../api/mcp.mjs";
import { createHandler as createSendHandler, INTENT as SEND_INTENT } from "../api/assistant/send.mjs";
import { createHandler as createDraftsHandler, INTENT as DRAFTS_INTENT } from "../api/assistant/drafts/index.mjs";
import { decide } from "../api/decide.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";
import { SCOPE_READ, SCOPE_DRAFT } from "../src/http/issuer.mjs";

process.env.LOGMEM_DECIDE_SECRET ||= "test-only-decide-key-0123456789abcdef";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

function clock(start = 1794448200000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.setHeader = (k, v) => ((r.headers[k.toLowerCase()] = v), r);
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (o) => ((r.body = o), r);
  r.end = () => r;
  return r;
}

const ENV = {
  LOGMEM_ADMIN_PASSWORD: "correct horse",
  VERCEL_ENV: "production",
  LOGMEM_VIEW_SPACES: "fieldnotes,madez",
  LOGMEM_ADMIN_SECRET: "admin-secret-drafts-test",
  LOGMEM_ADMIN_ID: "admin",
};
const cookie = issueCookie(ENV).split(";")[0];

async function seeded({ now } = {}) {
  const redis = createMemoryRedis();
  const n = now || clock();
  const lm = createLogmem({ redis, space: "fieldnotes", surface: "codex", sessionId: "drafter-s", now: n });
  await sc(lm, "logmem_start", { agent: "logmem-drafter" });
  await sc(lm, "logmem_assign", { job: "phase0", title: "Phase 0 drafter foundations" });
  return { redis, lm, store: createStore(redis, { space: "fieldnotes" }), now: n };
}

function redisKeys(redis, pred) {
  return [...redis._data.keys()].filter(pred);
}

// ─── §14.3 draft_ask writes only the draft key ───────────────────────────
test("§14.3 logmem_draft_ask writes only the draft key; no lmAskKey, approval or waiting_on", async () => {
  const { redis, lm, store } = await seeded();
  const out = await sc(lm, "logmem_draft_ask", {
    question: "Merge the Phase 0 PR?",
    action: "gh pr merge --squash",
    for: "human:admin",
    where: "job:phase0",
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.draft.kind, "ask");
  assert.equal(out.draft.status, "draft");
  assert.equal(out.draft.ask.reversible, false);
  assert.equal(out.draft.for, "human:admin");

  const draftKeys = redisKeys(redis, (k) => k.includes(":draft:"));
  assert.ok(draftKeys.some((k) => k === lmDraftKey("fieldnotes", "admin", out.draft.id)));
  assert.equal(redisKeys(redis, (k) => k.includes(":ask:")).length, 0, "no lmAskKey");

  const jobLog = (await sc(lm, "logmem_open", { job: "phase0" })).log;
  assert.equal(jobLog.filter((e) => e.kind === "approval").length, 0, "no approval entry");

  const brief = await sc(lm, "logmem_brief", {});
  assert.equal(brief.pending_asks?.length || 0, 0);
  assert.equal(brief.now?.waiting_on ?? null, null);

  const listed = await listDrafts((...a) => store.redis(...a), { space: "fieldnotes", person: "human:admin" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, out.draft.id);
});

// ─── §14.4 reversible forced false ───────────────────────────────────────
test("§14.4 reversible is forced false on create even when the caller sends true", async () => {
  const redis = createMemoryRedis();
  const draft = await createDraft(redis, {
    space: "fieldnotes",
    person: "human:admin",
    kind: "ask",
    ask: {
      question: "Delete the space?",
      action: "logmem_remove confirm",
      reversible: true,
      where: "job:phase0",
    },
  });
  assert.equal(draft.ask.reversible, false);
  const again = await getDraft(redis, { space: "fieldnotes", person: "human:admin", draftId: draft.id });
  assert.equal(again.ask.reversible, false);
});

// ─── §14.5 draft caps ────────────────────────────────────────────────────
test("§14.5 draft caps: question over 1000 and action over 4000 are refused", async () => {
  const redis = createMemoryRedis();
  await assert.rejects(
    () => createDraft(redis, {
      space: "fieldnotes",
      person: "human:admin",
      kind: "ask",
      ask: { question: "q".repeat(1001), action: "ok" },
    }),
    (e) => e instanceof DraftError && /question/.test(e.message),
  );
  await assert.rejects(
    () => createDraft(redis, {
      space: "fieldnotes",
      person: "human:admin",
      kind: "ask",
      ask: { question: "ok", action: "a".repeat(4001) },
    }),
    (e) => e instanceof DraftError && /action/.test(e.message),
  );

  const { lm } = await seeded();
  const overQ = await sc(lm, "logmem_draft_ask", {
    question: "q".repeat(1001),
    action: "ok",
    for: "human:admin",
  });
  assert.equal(overQ.ok, false);
  const overA = await sc(lm, "logmem_draft_ask", {
    question: "ok",
    action: "a".repeat(4001),
    for: "human:admin",
  });
  assert.equal(overA.ok, false);
});

test("draft TTL defaults to 30 days and index lists only status=draft", async () => {
  const redis = createMemoryRedis();
  const d = await createDraft(redis, {
    space: "fieldnotes",
    person: "human:admin",
    kind: "note",
    note: { summary: "hello draft" },
  });
  const key = lmDraftKey("fieldnotes", "admin", d.id);
  // memory-redis stores EX via oauthRedis; createMemoryRedis may not track TTL —
  // assert the constant and that discard drops it from list.
  assert.equal(DRAFT_TTL_S, 30 * 24 * 60 * 60);
  assert.equal((await listDrafts(redis, { space: "fieldnotes", person: "human:admin" })).length, 1);
  await discardDraft(redis, { space: "fieldnotes", person: "human:admin", draftId: d.id });
  assert.equal((await listDrafts(redis, { space: "fieldnotes", person: "human:admin" })).length, 0);
  assert.equal((await getDraft(redis, { space: "fieldnotes", person: "human:admin", draftId: d.id })).status, "discarded");
  assert.ok(key);
});

// ─── §14.6–7 draft scope ─────────────────────────────────────────────────
test("§14.6–7 draft scope: draft tools allowed; write tools and unknown names refused", async () => {
  const toolDefs = createLogmem({ redis: async () => null, space: "fieldnotes" }).listTools();
  const call = (name) => ({ method: "tools/call", params: { name } });
  const draftAuth = { scopes: [SCOPE_READ, SCOPE_DRAFT] };

  assert.equal(insufficientScope(draftAuth, call("logmem_brief"), toolDefs), false, "reads allowed");
  assert.equal(insufficientScope(draftAuth, call("logmem_draft_ask"), toolDefs), false, "draft_ask allowed");
  assert.equal(insufficientScope(draftAuth, call("logmem_draft_note"), toolDefs), false, "draft_note allowed");

  for (const name of ["logmem_ask", "logmem_note", "logmem_remove", "logmem_assign", "logmem_update", "logmem_recap"]) {
    assert.equal(insufficientScope(draftAuth, call(name), toolDefs), true, `${name} refused`);
  }
  assert.equal(insufficientScope(draftAuth, call("no-such-tool"), toolDefs), true, "unknown fails closed");

  const readAuth = { scopes: [SCOPE_READ] };
  assert.equal(insufficientScope(readAuth, call("logmem_draft_ask"), toolDefs), true, "read-only cannot draft");
});

// ─── §14.8 send route gates ──────────────────────────────────────────────
test("§14.8 send route refuses without intent, session, wrong origin, or non-draft status", async () => {
  const now = clock();
  const { redis, store } = await seeded({ now });
  const draft = await createDraft((...a) => store.redis(...a), {
    space: "fieldnotes",
    person: "human:admin",
    kind: "ask",
    ask: { question: "Ship Phase 0?", action: "open draft PR", where: "job:phase0" },
    now: now(),
  });
  const send = createSendHandler({ env: ENV, redis, now });
  const run = async (req) => {
    const res = mockRes();
    await send(req, res);
    return res;
  };
  const body = { space: "fieldnotes", draftId: draft.id };
  const base = {
    method: "POST",
    headers: {
      host: "logmem.example",
      origin: "https://logmem.example",
      cookie,
      "x-logmem-intent": SEND_INTENT,
      "content-type": "application/json",
    },
    body,
  };

  assert.equal((await run({ ...base, method: "GET" })).statusCode, 405);
  assert.equal((await run({ ...base, headers: { ...base.headers, cookie: "" } })).statusCode, 401, "no session");
  assert.equal((await run({ ...base, headers: { ...base.headers, "x-logmem-intent": "" } })).statusCode, 403, "no intent");
  assert.equal((await run({ ...base, headers: { ...base.headers, "x-logmem-intent": "decide" } })).statusCode, 403, "wrong intent");
  assert.equal((await run({ ...base, headers: { ...base.headers, origin: "https://evil.example" } })).statusCode, 403, "cross origin");

  await markDraftSent((...a) => store.redis(...a), {
    space: "fieldnotes",
    person: "human:admin",
    draftId: draft.id,
    trail: "already-sent",
  });
  const notDraft = await run(base);
  assert.equal(notDraft.statusCode, 409);
  assert.equal(notDraft.body.error, "not_draft");
});

// ─── §14.9 send then decide; second send 409 ─────────────────────────────
test("§14.9 send promotes once; decide accepts; second send returns 409 not_draft", async () => {
  const now = clock();
  const { redis, lm, store } = await seeded({ now });
  const draftOut = await sc(lm, "logmem_draft_ask", {
    question: "Open the Phase 0 draft PR?",
    action: "gh pr create --draft",
    for: "human:admin",
    where: "job:phase0",
  });
  assert.equal(draftOut.ok, true, JSON.stringify(draftOut));

  const send = createSendHandler({ env: ENV, redis, now });
  const runSend = async (req) => {
    const res = mockRes();
    await send(req, res);
    return res;
  };
  const headers = {
    host: "logmem.example",
    origin: "https://logmem.example",
    cookie,
    "x-logmem-intent": SEND_INTENT,
    "content-type": "application/json",
  };
  const first = await runSend({
    method: "POST",
    headers,
    body: { space: "fieldnotes", draftId: draftOut.draft.id },
  });
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.contract, 1);
  assert.ok(first.body.trail);
  assert.equal(first.body.draft.status, "sent");

  const askKey = lmAskKey("fieldnotes", first.body.trail);
  assert.ok(await redis("GET", askKey), "ask registry written once");
  const jobLog = (await sc(lm, "logmem_open", { job: "phase0" })).log;
  assert.equal(jobLog.filter((e) => e.kind === "approval" && e.trail === first.body.trail).length, 1);
  assert.equal(jobLog.find((e) => e.trail === first.body.trail).by, "human:admin");

  now.advance(1000);
  // OQ8 (sender may approve) is Phase 2: a different person answers.
  const decideEnv = { ...ENV, LOGMEM_ADMIN_ID: "mikey", LOGMEM_ADMIN_SECRET: ENV.LOGMEM_ADMIN_SECRET };
  const decideCookie = issueCookie(decideEnv).split(";")[0];
  const runDecide = async (req) => {
    const res = mockRes();
    await decide(req, res, { env: decideEnv, redis });
    return res;
  };
  const decided = await runDecide({
    method: "POST",
    headers: {
      host: "logmem.example",
      origin: "https://logmem.example",
      cookie: decideCookie,
      "x-logmem-intent": "decide",
      "content-type": "application/json",
    },
    body: {
      space: "fieldnotes",
      trail: first.body.trail,
      verdict: "approve",
      note: "go",
      confirm: "approve",
    },
  });
  assert.equal(decided.statusCode, 201, JSON.stringify(decided.body));
  assert.equal(decided.body.entry.payload.verdict, "approve");
  assert.equal(decided.body.entry.by, "human:mikey");

  const second = await runSend({
    method: "POST",
    headers,
    body: { space: "fieldnotes", draftId: draftOut.draft.id },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.error, "not_draft");
});

test("drafts API: list, patch and discard for the signed-in person", async () => {
  const now = clock();
  const { redis, store } = await seeded({ now });
  const draft = await createDraft((...a) => store.redis(...a), {
    space: "fieldnotes",
    person: "human:admin",
    kind: "ask",
    ask: { question: "Edit me?", action: "noop", where: "job:phase0" },
    now: now(),
  });
  const h = createDraftsHandler({ env: ENV, redis });
  const run = async (req) => {
    const res = mockRes();
    await h(req, res);
    return res;
  };
  const auth = { cookie, host: "logmem.example", origin: "https://logmem.example" };

  const listed = await run({
    method: "GET",
    url: "/api/assistant/drafts?space=fieldnotes",
    headers: auth,
  });
  assert.equal(listed.statusCode, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.contract, 1);
  assert.equal(listed.body.drafts.length, 1);
  assert.equal(listed.body.drafts[0].id, draft.id);

  const patched = await run({
    method: "PATCH",
    url: `/api/assistant/drafts/${draft.id}`,
    headers: { ...auth, "x-logmem-intent": DRAFTS_INTENT },
    body: { space: "fieldnotes", ask: { question: "Edited question?" } },
  });
  assert.equal(patched.statusCode, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.draft.ask.question, "Edited question?");

  const discarded = await run({
    method: "DELETE",
    url: `/api/assistant/drafts/${draft.id}`,
    headers: { ...auth, "x-logmem-intent": DRAFTS_INTENT },
    body: { space: "fieldnotes" },
  });
  assert.equal(discarded.statusCode, 200);
  assert.equal(discarded.body.draft.status, "discarded");
  assert.equal((await listDrafts((...a) => store.redis(...a), { space: "fieldnotes", person: "human:admin" })).length, 0);
});

test("logmem_draft_note holds a note without writing the channel log", async () => {
  const { redis, lm } = await seeded();
  const out = await sc(lm, "logmem_draft_note", {
    summary: "Phase 0 foundations ready for review",
    for: "human:admin",
    channel: "agent-coordination",
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.draft.kind, "note");
  const view = await sc(lm, "logmem_view", { ref: "channel:agent-coordination", limit: 20 });
  assert.equal((view.log || []).filter((e) => /Phase 0 foundations ready/.test(e.summary || "")).length, 0);
  assert.ok(redisKeys(redis, (k) => k.includes(":draft:")).length >= 1);
});
