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

import { lmSessionKey, checkAgentId } from "./keys.mjs";
import { tryParse } from "./store.mjs";
import { randomBytes, createHash } from "node:crypto";

export const IDLE_MS = 30 * 60 * 1000;
/** Shift bookkeeping is dropped a week after the last call. */
export const SESSION_TTL_S = 7 * 24 * 3600;

export const agentRef = (agent) => (String(agent).startsWith("agent:") ? String(agent) : `agent:${agent}`);
export const agentId = (agent) => String(agent).replace(/^agent:/, "");
export { checkAgentId };

/** "quill (via claude-code)" — how every entry names its writer. */
export const byline = (agent, surface) => `${agentId(agent)} (via ${surface || "unknown"})`;

const fullSlug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
const slug = (s) => fullSlug(s).slice(0, 60);

/**
 * The stored-session key segment for a session id. Ids up to 60 slug
 * characters keep their old key. Longer ids keep a 40-character prefix plus a
 * hash of the whole id, so truncation can never merge two sessions (codex,
 * review of PR #58: a long id cut the agent key's scope off the end).
 */
export function sessionKeyPart(sessionId) {
  const full = fullSlug(sessionId) || "default";
  if (full.length <= 60) return full;
  return `${full.slice(0, 40)}-${createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 19)}`;
}

export function createShifts(store, { sessionId, surface, defaultAgent, lockedAgent = null, idleMs = IDLE_MS, now = Date.now } = {}) {
  if (!sessionId) throw new Error("createShifts: sessionId required");
  const locked = lockedAgent ? checkAgentId(String(lockedAgent)) : null;
  const key = lmSessionKey(store.space, sessionKeyPart(sessionId));

  async function load() {
    return tryParse(await store.redis("GET", key)) || null;
  }
  async function save(rec) {
    await store.redis("SET", key, JSON.stringify(rec));
    await store.redis("EXPIRE", key, SESSION_TTL_S);
    return rec;
  }

  function validAgent(id) {
    if (typeof id !== "string") return null;
    try {
      return checkAgentId(id);
    } catch {
      return null;
    }
  }

  function fallbackAgent() {
    if (locked) return locked;
    const raw = defaultAgent || slug(surface) || "guest";
    const id = validAgent(agentId(raw));
    // A configured default that is not an agent id fails closed. It must not
    // start a shift under a made-up name. A valid surface slug is the fallback
    // when the stored shift names an agent id that does not validate.
    if (id) return id;
    return checkAgentId(String(raw));
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
    await store.setRecap(agent, recap);
    return recap;
  }

  /** Open a shift for `agent` and log Started. */
  async function startShift(agent, { auto = false, modelId } = {}) {
    const a = checkAgentId(String(agent));
    const ts = now();
    const shift = `${a}Shift-${ts}-${randomBytes(12).toString("hex")}`;
    const rec = { agent: a, surface, shift, started_at: ts, last_seen: ts, auto };
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
    await store.addShift(a, { ts, shift, session_id: sessionId, surface, model_id: modelId || "unknown", auto });
    await save(rec);
    return rec;
  }

  return {
    sessionId,
    surface,
    idleMs,

    current: async () => {
      const rec = await load();
      return locked && rec && rec.agent !== locked ? null : rec;
    },

    /**
     * Who is working, for a read-only tool, with no write: the open shift if
     * there is one, else this connection's agent with no shift. Never starts,
     * recaps or bumps last_seen (pure reads, plugin pilot spec section 8).
     */
    async peek() {
      let rec = await load();
      if (rec && !validAgent(rec.agent)) rec = null;
      if (rec && locked && rec.agent !== locked) rec = null;
      if (rec && !rec.ended && now() - rec.last_seen <= idleMs) return rec;
      try {
        return { agent: (rec && validAgent(rec.agent)) || fallbackAgent(), surface, shift: null, peek: true };
      } catch {
        return null;
      }
    },

    /**
     * Call before every tool. Handles idle Recap + auto Start. Returns the
     * open shift plus what happened (`events`) so tools can surface it.
     */
    async touch(toolName) {
      const events = [];
      let rec = await load();
      // A tampered or non-id agent must not be recapped or resumed, and a
      // locked connection never resumes another agent's shift.
      if (rec && !validAgent(rec.agent)) rec = null;
      if (rec && locked && rec.agent !== locked) rec = null;
      const t = now();
      if (rec && !rec.ended && t - rec.last_seen > idleMs) {
        rec = { ...rec, agent: validAgent(rec.agent) };
        await recapShift(rec, { reason: "idle" });
        events.push({ type: "auto-recap", agent: rec.agent, shift: rec.shift });
        rec = await save({ ...rec, ended: true, ended_at: t });
      }
      if ((!rec || rec.ended) && toolName !== "logmem_start") {
        const agent = (rec && validAgent(rec.agent)) || fallbackAgent();
        rec = await startShift(agent, { auto: true });
        events.push({ type: "auto-start", agent: rec.agent, shift: rec.shift });
      }
      if (rec && !rec.ended) rec = await save({ ...rec, last_seen: t });
      return { shift: rec && !rec.ended ? rec : null, events };
    },

    /**
     * The agent this connection is set to at connect: the locked agent (agent key,
     * managed sign-in), else LOGMEM_AGENT or the token's agent. Null when nothing
     * is set. The surface name never counts: a bare start must not guess.
     */
    boundAgent() {
      if (locked) return locked;
      return defaultAgent ? validAgent(agentId(String(defaultAgent))) : null;
    },

    /** Explicit Start / persona switch. */
    async start(agent, { modelId } = {}) {
      const events = [];
      const a = checkAgentId(agent);
      if (locked && a !== locked) throw new Error(`this connection's key is bound to agent ${locked}; start ${locked} instead`);
      let rec = await load();
      if (rec && !validAgent(rec.agent)) rec = null;
      if (rec && locked && rec.agent !== locked) rec = null;
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
      if (!rec || rec.ended || !validAgent(rec.agent)) throw new Error("no open shift to recap (call logmem_start first)");
      if (locked && rec.agent !== locked) throw new Error(`no open shift for ${locked} to recap (call logmem_start first)`);
      const recap = await recapShift(rec, { notes, next, reason: "recap" });
      if (end) await save({ ...rec, ended: true, ended_at: now() });
      return recap;
    },

    /** stdio timer: write the idle Recap without waiting for the next call. */
    async sweep() {
      const rec = await load();
      if (rec && !validAgent(rec.agent)) return false;
      if (rec && locked && rec.agent !== locked) return false;
      if (rec && !rec.ended && now() - rec.last_seen > idleMs) {
        await recapShift(rec, { reason: "idle" });
        await save({ ...rec, ended: true, ended_at: now() });
        return true;
      }
      return false;
    },
  };
}
