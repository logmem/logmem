// session.mjs — shifts: auto Start, auto Recap, and the persona switch.
//
// A shift is one stretch of work by one agent on one surface. The server
// tracks it so agents don't have to remember the ritual:
//
//   - First tool call of a session with no open shift -> auto Start.
//   - A call arriving after IDLE_MS of silence -> auto Recap of the old
//     shift, then a fresh auto Start. (Lazy, so it works on serverless where
//     nothing runs between requests. stdio also runs a timer; see sweep().)
//   - logmem_start <agent> while another agent holds the shift -> Recap the
//     previous agent, then Start + Brief the new one.
//
// Shift state lives in Redis (lm:{space}:session:{sid}) so stateless HTTP
// requests that share a session id see the same shift.

import { lmSessionKey } from "./keys.mjs";
import { tryParse } from "./store.mjs";

export const IDLE_MS = 30 * 60 * 1000;
/** Shift bookkeeping is dropped a week after the last call. */
export const SESSION_TTL_S = 7 * 24 * 3600;

export const agentRef = (agent) => (String(agent).startsWith("agent:") ? String(agent) : `agent:${agent}`);
export const agentId = (agent) => String(agent).replace(/^agent:/, "");

/** "quill (via claude-code)" — how every entry names its writer. */
export const byline = (agent, surface) => `${agentId(agent)} (via ${surface || "unknown"})`;

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export function createShifts(store, { sessionId, surface, defaultAgent, idleMs = IDLE_MS, now = Date.now } = {}) {
  if (!sessionId) throw new Error("createShifts: sessionId required");
  const key = lmSessionKey(store.space, slug(sessionId) || "default");

  async function load() {
    return tryParse(await store.redis("GET", key)) || null;
  }
  async function save(rec) {
    await store.redis("SET", key, JSON.stringify(rec));
    await store.redis("EXPIRE", key, SESSION_TTL_S);
    return rec;
  }

  function fallbackAgent() {
    return agentId(defaultAgent || slug(surface) || "guest");
  }

  /** Build and write a mechanical Recap for the shift in `rec`. */
  async function recapShift(rec, { reason, notes, next } = {}) {
    const agent = rec.agent;
    const since = rec.started_at;
    const mine = (await store.readLog("agent", agent, { sinceMs: since })).filter(
      (e) => e.shift === rec.shift,
    );
    const kinds = {};
    for (const e of mine) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    const ts = now();
    const recap = {
      agent,
      shift: rec.shift,
      mode: notes ? "manual" : "auto",
      reason: reason || (notes ? "recap" : "idle"),
      started_at: since,
      ended_at: ts,
      surface: rec.surface,
      summary: notes || `${mine.length} entries this shift${mine.length ? `: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}` : ""}.`,
      last_entries: mine.slice(-5).map((e) => ({ ts: e.ts, kind: e.kind, summary: e.summary })),
      next: next || [],
      updated_at: ts,
    };
    await store.setRecap(agent, recap);
    await store.append("agent", agent, {
      ts,
      kind: "recap",
      by: agentRef(agent),
      via: rec.surface,
      byline: byline(agent, rec.surface),
      trail: `${rec.shift}-recap`,
      origin: rec.shift,
      shift: rec.shift,
      summary: `${agentId(agent)} recap (${recap.mode}${reason ? `, ${reason}` : ""}): ${recap.summary}`,
    });
    return recap;
  }

  /** Open a shift for `agent` and log Started. */
  async function startShift(agent, { auto = false, modelId } = {}) {
    const a = agentId(agent);
    const ts = now();
    const shift = `${a}Shift-${ts}`;
    const rec = { agent: a, surface, shift, started_at: ts, last_seen: ts, auto };
    await store.addShift(a, { ts, shift, session_id: sessionId, surface, model_id: modelId || "unknown", auto });
    await store.append("agent", a, {
      ts,
      kind: "started",
      by: agentRef(a),
      via: surface,
      byline: byline(a, surface),
      trail: shift,
      shift,
      summary: `${byline(a, surface)} started a shift${auto ? " (auto)" : ""}`,
    });
    await save(rec);
    return rec;
  }

  return {
    sessionId,
    surface,
    idleMs,

    current: load,

    /**
     * Call before every tool. Handles idle Recap + auto Start. Returns the
     * open shift plus what happened (`events`) so tools can surface it.
     */
    async touch(toolName) {
      const events = [];
      let rec = await load();
      const t = now();
      if (rec && !rec.ended && t - rec.last_seen > idleMs) {
        await recapShift(rec, { reason: "idle" });
        events.push({ type: "auto-recap", agent: rec.agent, shift: rec.shift });
        rec = await save({ ...rec, ended: true, ended_at: t });
      }
      if ((!rec || rec.ended) && toolName !== "logmem_start") {
        const agent = rec?.agent || fallbackAgent();
        rec = await startShift(agent, { auto: true });
        events.push({ type: "auto-start", agent: rec.agent, shift: rec.shift });
      }
      if (rec && !rec.ended) rec = await save({ ...rec, last_seen: t });
      return { shift: rec && !rec.ended ? rec : null, events };
    },

    /** Explicit Start / persona switch. */
    async start(agent, { modelId } = {}) {
      const events = [];
      const a = agentId(agent);
      const rec = await load();
      if (rec && !rec.ended) {
        if (rec.agent === a) {
          await save({ ...rec, last_seen: now() });
          return { shift: rec, events: [{ type: "already-started", agent: a, shift: rec.shift }] };
        }
        const recap = await recapShift(rec, { reason: `switch to ${a}` });
        events.push({ type: "switch-recap", agent: rec.agent, shift: rec.shift, recap });
        await save({ ...rec, ended: true, ended_at: now() });
      }
      const next = await startShift(a, { modelId });
      events.push({ type: "start", agent: a, shift: next.shift });
      return { shift: next, events };
    },

    /** Explicit Recap with the agent's own notes; ends the shift. */
    async recap({ notes, next, end = true } = {}) {
      const rec = await load();
      if (!rec || rec.ended) throw new Error("no open shift to recap (call logmem_start first)");
      const recap = await recapShift(rec, { notes, next, reason: "recap" });
      if (end) await save({ ...rec, ended: true, ended_at: now() });
      return recap;
    },

    /** stdio timer: write the idle Recap without waiting for the next call. */
    async sweep() {
      const rec = await load();
      if (rec && !rec.ended && now() - rec.last_seen > idleMs) {
        await recapShift(rec, { reason: "idle" });
        await save({ ...rec, ended: true, ended_at: now() });
        return true;
      }
      return false;
    },
  };
}
