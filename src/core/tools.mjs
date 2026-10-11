// tools.mjs — the 21 logmem_* tools.
//
// Plain-language descriptions on purpose: the descriptions plus the server
// instructions are the portable "skill" that Claude, Codex, Grok and
// Perplexity all read. Schemas are DRAFT (v0) until the tool-contract spec
// from claude-engineer lands on 2026-10-14.
//
// Every tool runs through the shift tracker first (auto Start / auto Recap),
// and every write records who wrote it as "agent (via surface)".

import { params } from "./params.mjs";
import { parseRef } from "./keys.mjs";
import { KINDS, normalizeKind } from "./vocab.mjs";
import { agentRef, agentId, byline } from "./session.mjs";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const STAGES = ["open", "active", "blocked", "done"];
const KIND_WORDS = Object.keys(KINDS);

const clock = (ctx) => (ctx.now || Date.now)();

function parseSince(s) {
  const m = String(s || "").match(/^(\d+)([mhd])$/);
  if (!m) return 0;
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}

const camel = (s) =>
  String(s)
    .replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
    .replace(/^./, (c) => c.toLowerCase());

/** Default trail: <kind><Id>-<ms>, matching the fleet's camelCase-epoch habit. */
export const makeTrail = (kind, id, ts) => `${camel(`${kind}-${id}`)}-${ts}`;

function me(ctx) {
  if (!ctx.shift) throw new Error("no open shift (call logmem_start)");
  return ctx.shift.agent;
}

/** Write one entry, stamped with who/where/which shift. */
async function write(ctx, ns, id, { kind, summary, trail, origin, payload, ts, extra }) {
  const agent = me(ctx);
  const t = ts ?? clock(ctx);
  const k = normalizeKind(kind);
  const entry = {
    ts: t,
    ...k,
    by: agentRef(agent),
    via: ctx.surface,
    byline: byline(agent, ctx.surface),
    trail: trail || makeTrail(k.kind, id, t),
    shift: ctx.shift.shift,
    summary,
    ...extra,
  };
  if (origin) entry.origin = origin;
  if (payload !== undefined) entry.payload = payload;
  return ctx.store.append(ns, id, entry);
}

async function brief(ctx, agent) {
  const a = agentId(agent);
  const s = ctx.store;
  const [who, now, log, recap, follows, shifts] = await Promise.all([
    s.getWho("agent", a),
    s.getNow("agent", a),
    s.readLog("agent", a, { reverse: true, limit: 20 }),
    s.getRecap(a),
    s.follows(a),
    s.recentShifts(a, 5),
  ]);
  const accepted = new Set(log.filter((e) => e.kind === "accepted" && e.origin).map((e) => e.origin));
  const waiting = log.filter((e) => e.kind === "handoff" && e.to === agentRef(a) && !accepted.has(e.trail));
  return { agent: a, space: s.space, who, now, recap, follows, log: log, handoffs_to_me: waiting, recent_shifts: shifts };
}

export const TOOLS = [
  // ─── Shift ──────────────────────────────────────────────────────────
  {
    name: "logmem_start",
    title: "Start",
    description:
      "Become an agent and begin a shift. Use this when someone says \"logmem start <agent>\". If another agent was working in this session, LogMem writes their Recap first, then starts the new one. Returns the new agent's Brief.",
    params: params({
      agent: { type: "string", desc: "Agent to become, e.g. 'quill' or 'agent:quill'" },
      model: { type: "string", desc: "Model id running this shift (optional)", optional: true },
    }),
    annotations: WRITE,
    async run({ agent, model }, ctx) {
      const { shift, events } = await ctx.shifts.start(agent, { modelId: model });
      ctx.shift = shift;
      return { ok: true, started: shift, switch: events, brief: await brief(ctx, shift.agent) };
    },
  },
  {
    name: "logmem_brief",
    title: "Brief",
    description:
      "Catch up before doing anything: reads an agent's Who, Now, recent Log, last Recap, what it follows and any handoffs waiting for it. Read only.",
    params: params({ agent: { type: "string", desc: "Agent to brief (default: you)", optional: true } }),
    annotations: READ,
    async run({ agent }, ctx) {
      return { ok: true, ...(await brief(ctx, agent || me(ctx))) };
    },
  },
  {
    name: "logmem_recap",
    title: "Recap",
    description:
      "Leave notes for the next shift and end this one. Say what got done and what comes next. Tomorrow's Brief starts here. (LogMem also writes an automatic Recap after 30 minutes idle.)",
    params: params({
      notes: { type: "string", desc: "What happened this shift, in a sentence or two" },
      next: { type: "strings", desc: "What the next shift should do first", optional: true },
      end: { type: "boolean", desc: "End the shift after recapping (default true)", optional: true },
    }),
    annotations: WRITE,
    async run({ notes, next, end }, ctx) {
      const recap = await ctx.shifts.recap({ notes, next, end: end !== false });
      return { ok: true, recap };
    },
  },

  // ─── Log ────────────────────────────────────────────────────────────
  {
    name: "logmem_note",
    title: "Note",
    description:
      "Write one entry to a log: a channel, a job, or an agent. Give it a kind from the LogMem words (memo, progress, decided, stuck, fix, ...). Link it to earlier work with trail (same piece of work) and origin (the entry this follows from).",
    params: params({
      to: { type: "string", desc: "Where to write: 'channel:<id>', 'job:<id>' or 'agent:<id>' (bare id = channel)" },
      summary: { type: "string", desc: "One line, plain language" },
      kind: { type: "string", desc: `Entry type. One of: ${KIND_WORDS.join(", ")}. Default memo.`, optional: true },
      trail: { type: "string", desc: "Trail id shared by every entry about this piece of work (auto if omitted)", optional: true },
      origin: { type: "string", desc: "Trail id of the entry this one follows from", optional: true },
      payload: { type: "object", desc: "Optional structured details", optional: true },
    }),
    annotations: WRITE,
    async run({ to, summary, kind, trail, origin, payload }, ctx) {
      const { ns, id } = parseRef(to);
      const entry = await write(ctx, ns, id, { kind, summary, trail, origin, payload });
      // An accepted handoff also lands on your own log, so your Brief stops
      // listing it as waiting.
      const mine = ns === "agent" && id === me(ctx);
      if (entry.kind === "accepted" && !mine) {
        await write(ctx, "agent", me(ctx), { kind, summary, trail: entry.trail, origin, payload, ts: entry.ts });
      }
      return { ok: true, to: `${ns}:${id}`, entry };
    },
  },
  {
    name: "logmem_handoff",
    title: "Handoff",
    description:
      "Pass work to another agent. Writes a Handoff entry on the job (or channel) and on the receiver's log, and makes the receiver follow it. The receiver confirms with logmem_note kind 'accepted' and origin set to this handoff's trail.",
    params: params({
      to: { type: "string", desc: "Agent receiving the work, e.g. 'atlas'" },
      summary: { type: "string", desc: "What is being handed over and what 'done' looks like" },
      job: { type: "string", desc: "Job or channel the work lives in, e.g. 'job:issue-14'", optional: true },
      trail: { type: "string", desc: "Trail id (auto if omitted)", optional: true },
      origin: { type: "string", desc: "Trail id this handoff follows from", optional: true },
    }),
    annotations: WRITE,
    async run({ to, summary, job, trail, origin }, ctx) {
      const receiver = agentId(to);
      const where = job ? parseRef(job, "job") : null;
      const t = clock(ctx);
      const tr = trail || makeTrail("handoff", where ? where.id : receiver, t);
      const extra = { to: agentRef(receiver), ...(where ? { job: `${where.ns}:${where.id}` } : {}) };
      const entries = [];
      if (where) entries.push(await write(ctx, where.ns, where.id, { kind: "handoff", summary, trail: tr, origin, ts: t, extra }));
      entries.push(await write(ctx, "agent", receiver, { kind: "handoff", summary, trail: tr, origin, ts: t, extra }));
      if (where) {
        await ctx.store.follow(receiver, `${where.ns}:${where.id}`, { role: "owner", joined_at: t, via: "handoff", trail: tr });
        if (where.ns === "job") await ctx.store.setNow("job", where.id, { owner: agentRef(receiver), handoff_trail: tr });
      }
      return { ok: true, trail: tr, to: agentRef(receiver), entries };
    },
  },
  {
    name: "logmem_ask",
    title: "Ask",
    description:
      "Stop and ask a human before anything irreversible: sending to customers, spending money, deleting, deploying, publishing. Show the exact action, not a summary. Then wait. Do not do the action until a 'decided' entry with origin = this trail says yes.",
    params: params({
      question: { type: "string", desc: "Plain question, e.g. 'Send issue 14 to 2,184 subscribers Tue 9am?'" },
      action: { type: "string", desc: "The exact action you will take if approved (command, request, recipients)" },
      reversible: { type: "boolean", desc: "Can this be undone afterwards?" },
      where: { type: "string", desc: "Job or channel this belongs to (default: your agent log)", optional: true },
      origin: { type: "string", desc: "Trail id this request follows from", optional: true },
    }),
    annotations: WRITE,
    async run({ question, action, reversible, where, origin }, ctx) {
      const agent = me(ctx);
      const loc = where ? parseRef(where, "job") : { ns: "agent", id: agent };
      const t = clock(ctx);
      const trail = makeTrail("approval", loc.id, t);
      const extra = { action, reversible, status: "waiting" };
      const entry = await write(ctx, loc.ns, loc.id, { kind: "approval", summary: question, trail, origin, ts: t, extra });
      if (loc.ns !== "agent") await write(ctx, "agent", agent, { kind: "approval", summary: question, trail, origin, ts: t, extra });
      await ctx.store.setNow("agent", agent, { waiting_on: { trail, question, since: t } });
      return {
        ok: true,
        trail,
        entry,
        instruction: "Waiting on a human. Do not perform the action. Resume only after a 'decided' entry with origin set to this trail.",
      };
    },
  },

  // ─── Who / Now ──────────────────────────────────────────────────────
  {
    name: "logmem_status",
    title: "Status",
    description: "Update what an agent is doing right now (its Now). Merges the fields you pass; other fields stay.",
    params: params({
      now: { type: "object", desc: "Fields to set, e.g. {\"doing\": \"drafting issue 14\", \"blocked\": false}" },
      agent: { type: "string", desc: "Agent (default: you)", optional: true },
    }),
    annotations: SET,
    async run({ now, agent }, ctx) {
      const a = agentId(agent || me(ctx));
      return { ok: true, agent: a, now: await ctx.store.setNow("agent", a, { ...now, updated_at: clock(ctx) }) };
    },
  },
  {
    name: "logmem_bio",
    title: "Bio",
    description: "Update who an agent is (its Who): name, role, owner, model. Merges by default; pass replace=true to overwrite.",
    params: params({
      who: { type: "object", desc: "Profile fields, e.g. {\"role\": \"newsletter writer\"}" },
      agent: { type: "string", desc: "Agent (default: you)", optional: true },
      replace: { type: "boolean", desc: "Overwrite instead of merge", optional: true },
    }),
    annotations: SET,
    async run({ who, agent, replace }, ctx) {
      const a = agentId(agent || me(ctx));
      const doc = replace ? await ctx.store.setWho("agent", a, who) : await ctx.store.mergeWho("agent", a, who);
      return { ok: true, agent: a, who: doc };
    },
  },
  {
    name: "logmem_view",
    title: "View",
    description: "Read one agent, channel or job: its Who, Now and recent Log. Read only.",
    params: params({
      ref: { type: "string", desc: "'agent:<id>', 'channel:<id>' or 'job:<id>'" },
      limit: { type: "number", desc: "How many recent entries (default 10)", optional: true },
    }),
    annotations: READ,
    async run({ ref, limit }, ctx) {
      const { ns, id } = parseRef(ref, "agent");
      const [who, now, log] = await Promise.all([
        ctx.store.getWho(ns, id),
        ctx.store.getNow(ns, id),
        ctx.store.readLog(ns, id, { reverse: true, limit: limit || 10 }),
      ]);
      return { ok: true, ref: `${ns}:${id}`, who, now, log };
    },
  },
  {
    name: "logmem_roster",
    title: "Roster",
    description: "List everyone (or every channel or job) in this space. Read only.",
    params: params({ of: { enum: ["agent", "channel", "job"], desc: "What to list (default agent)", optional: true } }),
    annotations: READ,
    async run({ of }, ctx) {
      const ns = of || "agent";
      return { ok: true, of: ns, ids: await ctx.store.list(ns) };
    },
  },
  {
    name: "logmem_feed",
    title: "Feed",
    description: "Merge several logs into one timeline, newest first. Good for 'what happened today'. Read only.",
    params: params({
      refs: { type: "strings", desc: "Logs to merge, e.g. ['channel:field-notes', 'job:issue-14', 'agent:quill']" },
      since: { type: "string", desc: "Window like '30m', '24h', '7d' (default all)", optional: true },
      limit: { type: "number", desc: "Max entries (default 50)", optional: true },
    }),
    annotations: READ,
    async run({ refs, since, limit }, ctx) {
      const sinceMs = since ? clock(ctx) - parseSince(since) : undefined;
      const merged = [];
      for (const r of refs) {
        const { ns, id } = parseRef(r);
        for (const e of await ctx.store.readLog(ns, id, { sinceMs })) merged.push({ ...e, from: `${ns}:${id}` });
      }
      merged.sort((a, b) => b.ts - a.ts);
      return { ok: true, entries: merged.slice(0, limit || 50) };
    },
  },
  {
    name: "logmem_follow",
    title: "Follow",
    description: "Join or leave a channel or job so it shows up in your Brief, or list what you follow.",
    params: params({
      action: { enum: ["follow", "unfollow", "list"], desc: "What to do" },
      ref: { type: "string", desc: "'channel:<id>' or 'job:<id>' (needed for follow/unfollow)", optional: true },
      role: { type: "string", desc: "Your role there, e.g. 'owner', 'reviewer' (default participant)", optional: true },
      agent: { type: "string", desc: "Agent (default: you)", optional: true },
    }),
    annotations: SET,
    async run({ action, ref, role, agent }, ctx) {
      const a = agentId(agent || me(ctx));
      if (action === "list") return { ok: true, agent: a, follows: await ctx.store.follows(a) };
      if (!ref) throw new Error("ref is required to follow/unfollow");
      const { ns, id } = parseRef(ref);
      const key = `${ns}:${id}`;
      if (action === "follow") await ctx.store.follow(a, key, { role: role || "participant", joined_at: clock(ctx) });
      else await ctx.store.unfollow(a, key);
      return { ok: true, agent: a, action, ref: key };
    },
  },

  // ─── Jobs ───────────────────────────────────────────────────────────
  {
    name: "logmem_assign",
    title: "Assign",
    description: "Open a new job: a piece of work with a title, an owner, a stage and its own log.",
    params: params({
      job: { type: "string", desc: "Job id, short and stable, e.g. 'issue-14'" },
      title: { type: "string", desc: "What the job is, in plain words" },
      owner: { type: "string", desc: "Agent who owns it (default: you)", optional: true },
      details: { type: "object", desc: "Anything else: due date, links, acceptance", optional: true },
    }),
    annotations: WRITE,
    async run({ job, title, owner, details }, ctx) {
      const { id } = parseRef(`job:${String(job).replace(/^(job|work):/, "")}`);
      const own = agentRef(owner || me(ctx));
      const who = { title, owner: own, created_by: agentRef(me(ctx)), created_at: clock(ctx), ...details };
      await ctx.store.setWho("job", id, who);
      await ctx.store.setNow("job", id, { stage: "open", owner: own });
      await ctx.store.addJobSession(id, ctx.shift.shift);
      const entry = await write(ctx, "job", id, { kind: "assigned", summary: `New job: ${title}` });
      return { ok: true, job: id, who, entry };
    },
  },
  {
    name: "logmem_update",
    title: "Update",
    description: "Add progress to a job's log. Default kind is progress.",
    params: params({
      job: { type: "string", desc: "Job id" },
      summary: { type: "string", desc: "What moved, in one line" },
      kind: { type: "string", desc: "Entry type (default progress)", optional: true },
      trail: { type: "string", desc: "Trail id (auto if omitted)", optional: true },
      origin: { type: "string", desc: "Trail id this follows from", optional: true },
    }),
    annotations: WRITE,
    async run({ job, summary, kind, trail, origin }, ctx) {
      const { id } = parseRef(job, "job");
      await ctx.store.addJobSession(id, ctx.shift.shift);
      const entry = await write(ctx, "job", id, { kind: kind || "progress", summary, trail, origin });
      return { ok: true, job: id, entry };
    },
  },
  {
    name: "logmem_stage",
    title: "Stage",
    description: "Move a job to open, active, blocked or done. Blocked writes a Stuck entry; done writes a Done entry.",
    params: params({
      job: { type: "string", desc: "Job id" },
      stage: { enum: STAGES, desc: "New stage" },
      note: { type: "string", desc: "Why (required in spirit for blocked: what broke, what it blocks)", optional: true },
    }),
    annotations: SET,
    async run({ job, stage, note }, ctx) {
      const { id } = parseRef(job, "job");
      const now = await ctx.store.setNow("job", id, { stage, stage_at: clock(ctx) });
      const kind = { blocked: "stuck", done: "done" }[stage] || "progress";
      const entry = await write(ctx, "job", id, { kind, summary: note ? `${stage}: ${note}` : `Stage -> ${stage}` });
      return { ok: true, job: id, now, entry };
    },
  },
  {
    name: "logmem_open",
    title: "Open",
    description: "Read one job in full: Who, Now, the last 50 log entries and the shifts that touched it. Read only.",
    params: params({
      job: { type: "string", desc: "Job id" },
      limit: { type: "number", desc: "How many entries (default 50)", optional: true },
    }),
    annotations: READ,
    async run({ job, limit }, ctx) {
      const { id } = parseRef(job, "job");
      const [who, now, log, shifts] = await Promise.all([
        ctx.store.getWho("job", id),
        ctx.store.getNow("job", id),
        ctx.store.readLog("job", id, { reverse: true, limit: limit || 50 }),
        ctx.store.jobSessions(id),
      ]);
      return { ok: true, job: id, who, now, log, shifts };
    },
  },
  {
    name: "logmem_jobs",
    title: "Jobs",
    description: "List every job in this space, optionally only those at one stage. Read only.",
    params: params({ stage: { enum: STAGES, desc: "Only jobs at this stage", optional: true } }),
    annotations: READ,
    async run({ stage }, ctx) {
      const ids = await ctx.store.list("job");
      if (!stage) return { ok: true, jobs: ids };
      const out = [];
      for (const id of ids) if ((await ctx.store.getNow("job", id)).stage === stage) out.push(id);
      return { ok: true, stage, jobs: out };
    },
  },

  // ─── Memory / admin ─────────────────────────────────────────────────
  {
    name: "logmem_recall",
    title: "Recall",
    description: "Search memory for something you didn't write. Finds entries by meaning when a semantic index is attached, otherwise by words. Read only.",
    params: params({
      query: { type: "string", desc: "What you're looking for, in plain words" },
      limit: { type: "number", desc: "Max results (default 5)", optional: true },
    }),
    annotations: READ,
    async run({ query, limit }, ctx) {
      return { ok: true, query, ...(await ctx.recall(query, limit || 5)) };
    },
  },
  {
    name: "logmem_remove",
    title: "Remove",
    description:
      "Delete one key in this space. Always a dry run first; only call again with confirm=true after a human has seen exactly what goes. Protected keys are never removed.",
    params: params({
      key: { type: "string", desc: "Full key, e.g. 'lm:<space>:channel:x:log'" },
      confirm: { type: "boolean", desc: "true to actually remove (default false = preview)", optional: true },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run({ key, confirm }, ctx) {
      const r = await ctx.store.remove(key, { confirm: confirm === true });
      if (r.removed) {
        await write(ctx, "agent", me(ctx), { kind: "fix", summary: `Removed ${key}` });
      }
      return { ok: true, ...r };
    },
  },
  {
    name: "logmem_spaces",
    title: "Spaces",
    description: "List the spaces this connection can use and which one is active. Each space is walled off from the others. Read only.",
    params: params({}),
    annotations: READ,
    skipTouch: true,
    async run(_args, ctx) {
      return { ok: true, space: ctx.store.space, spaces: ctx.spaces };
    },
  },
  {
    name: "logmem_connection",
    title: "Connection",
    description: "Check the link to LogMem is up: backend, space, compatibility mode and the current shift. Read only.",
    params: params({}),
    annotations: READ,
    skipTouch: true,
    async run(_args, ctx) {
      let ping = null;
      try {
        ping = await ctx.store.redis("PING");
      } catch (e) {
        ping = `error: ${e.message}`;
      }
      return {
        ok: true,
        backend: ctx.backend,
        ping,
        space: ctx.store.space,
        acmi_compat: ctx.store.compat,
        degraded: ctx.backend === "memory",
        surface: ctx.surface,
        shift: await ctx.shifts.current(),
      };
    },
  },
];

/** Keyword recall over this space's logs. Bounded; used when no index is attached. */
export async function keywordRecall(store, query, limit) {
  const words = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (!words.length) return { mode: "keyword", results: [] };
  const hits = [];
  for (const ns of ["channel", "job", "agent"]) {
    for (const id of (await store.list(ns)).slice(0, 200)) {
      for (const e of await store.readLog(ns, id, { reverse: true, limit: 500 })) {
        const text = `${e.summary || ""} ${JSON.stringify(e.payload ?? "")}`.toLowerCase();
        const score = words.filter((w) => text.includes(w)).length / words.length;
        if (score > 0) hits.push({ relevance: score, from: `${ns}:${id}`, ts: e.ts, kind: e.kind, summary: e.summary, trail: e.trail });
      }
    }
  }
  hits.sort((a, b) => b.relevance - a.relevance || b.ts - a.ts);
  return { mode: "keyword", results: hits.slice(0, limit) };
}
