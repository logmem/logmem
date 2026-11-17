// register-ask.mjs — shared ask registration for logmem_ask and /api/assistant/send.
//
// Spec: docs/superpowers/specs/2026-11-06-builtin-drafting-agent-design.md §5.5
// Preserves logmem_ask behaviour: warn mode may fall back to the asker's agent
// log when where is missing; an explicit agent:/job: where is honoured.

import { parseRef, lmAskKey } from "./keys.mjs";
import { linkOpen, jobOf } from "./links.mjs";

export class RegisterAskError extends Error {
  constructor(message, code = "bad_request") {
    super(message);
    this.name = "RegisterAskError";
    this.code = code;
  }
}

/**
 * Register one ask. asker is "agent:<id>" or "human:<id>".
 * store is createStore-bound. Returns { ok, trail, entry, job? }.
 *
 * workRules: "strict" (default) requires an existing job when where is a job
 * (or missing). "warn" lets missing/unknown jobs through with the same
 * placement rules as the pre-extraction logmem_ask.
 */
export async function registerAsk(store, {
  question,
  action,
  reversible = false,
  where,
  to,
  origin,
  asker,
  via = "mcp",
  now = Date.now,
  shift = null,
  workRules = "strict",
} = {}) {
  // Lazy import avoids a cycle with tools.mjs (which exports askDigest/makeTrail).
  const { askDigest, makeTrail, LIMITS, HUMAN_RE } = await import("./tools.mjs");
  const q = String(question || "");
  const a = String(action || "");
  if (!q || q.length > LIMITS.summary) throw new RegisterAskError(`question required, max ${LIMITS.summary} characters`);
  if (!a || a.length > LIMITS.action) throw new RegisterAskError(`action required, max ${LIMITS.action} characters`);
  if (to != null && !HUMAN_RE.test(String(to))) {
    throw new RegisterAskError("to must be a person, 'human:<id>'");
  }
  if (typeof asker !== "string" || !(asker.startsWith("agent:") || asker.startsWith("human:"))) {
    throw new RegisterAskError("asker must be agent:<id> or human:<id>");
  }

  const warn = workRules === "warn";
  const hint = `Open a job first with logmem_assign (it goes in a plan), then pass where: "job:<id>"`;
  const whereRef = where || null;
  const jobId = jobOf(whereRef);
  const askerBare = asker.replace(/^(agent|human):/, "");

  // Placement matches historic logmem_ask: explicit where → parseRef; else agent log.
  let loc;
  if (whereRef) {
    try {
      loc = parseRef(whereRef, "job");
    } catch (e) {
      throw new RegisterAskError(e.message);
    }
  } else if (warn && asker.startsWith("agent:")) {
    loc = { ns: "agent", id: askerBare };
  } else {
    throw new RegisterAskError(`A decision must be on a job: where is '(none)'. ${hint}`);
  }

  let linkJobId = null;
  if (loc.ns === "job") {
    const exists = await store.getWho("job", loc.id);
    if (!exists && !warn) {
      throw new RegisterAskError(`A decision is on job '${loc.id}', which does not exist. ${hint}`);
    }
    if (exists) linkJobId = loc.id;
  } else if (!warn && !jobId) {
    // Strict mode still requires a job for a live decision, unless where was
    // explicitly an agent: ref (legacy / warn-era placement tested in suite).
    // Explicit agent: where is allowed so writeDecision can target that log.
  }

  // Strict: missing where already threw. Explicit non-job where is allowed
  // (historic). Missing job under a job: where already threw above when !warn.

  const t = typeof now === "function" ? now() : now;
  const trail = makeTrail("approval", loc.id, t);
  const extra = {
    action: a,
    reversible: reversible === true,
    status: "waiting",
    where: `${loc.ns}:${loc.id}`,
    ...(to != null ? { to } : {}),
  };
  const hash = askDigest({ trail, by: asker, ts: t, summary: q, ...extra });
  const askerKind = asker.startsWith("human:") ? "human" : "agent";
  const reg = await store.redis("SET", lmAskKey(store.space, trail), JSON.stringify({
    hash,
    asker: askerBare,
    // Phase 0 Send registers the person as asker. Legacy rows omit this and mean agent.
    asker_kind: askerKind,
    where: extra.where,
    ts: t,
  }), "NX");
  if (reg == null) throw new RegisterAskError(`an ask with trail '${trail}' already exists; a trail carries one ask`, "conflict");

  const entry = {
    ts: t,
    kind: "approval",
    by: asker,
    via,
    byline: `${askerBare} (via ${via})`,
    trail,
    summary: q,
    ...extra,
    ...(origin ? { origin } : {}),
    ...(shift ? { shift } : {}),
  };
  await store.append(loc.ns, loc.id, entry);
  if (asker.startsWith("agent:")) {
    if (!(loc.ns === "agent" && loc.id === askerBare)) {
      await store.append("agent", askerBare, { ...entry });
    }
    await store.setNow("agent", askerBare, { waiting_on: { trail, question: q, since: t } });
  }

  const job = linkJobId
    ? await linkOpen(store, linkJobId, { type: "decision", ref: trail, note: q, now: () => t })
    : null;
  return {
    ok: true,
    trail,
    entry,
    job: job ? { id: linkJobId, stage: job.stage, blocked_on: job.blocked_on } : undefined,
  };
}
