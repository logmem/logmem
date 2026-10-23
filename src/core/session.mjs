// session.mjs — shifts: auto Start, auto Recap, and the persona switch.
//
// A shift is one stretch of work by one agent on one surface. The server
// tracks it so agents don't have to remember the ritual:
//
//   - First tool call of a session with no open shift -> resume the agent's
//     open shift on this surface, else auto Start. A new session alone never
//     starts a shift, so a stateless client (one session per call) keeps one.
//   - Unmanaged auto Starts write metadata only. Managed starts keep their
//     admitted log entry so quota rejection creates no lifecycle metadata.
//   - A call arriving after IDLE_MS of silence -> auto Recap of the old
//     shift, then a fresh auto Start. (Lazy, so it works on serverless where
//     nothing runs between requests. stdio also runs a timer; see sweep().)
//     No idle Recap is written for a shift that wrote nothing but its start.
//   - logmem_start <agent> while another agent holds the shift -> Recap the
//     previous agent, then Start + Brief the new one.
//
// Shift state lives in Redis (lm:{space}:session:{sid}) so stateless HTTP
// requests that share a session id see the same shift. The agent's open shift
// on a surface lives beside it (session "open-shift-{agent}-{surface}"), so
// requests with different session ids find it too.

import { lmSessionKey, checkAgentId } from "./keys.mjs";
import { tryParse } from "./store.mjs";
import { randomBytes, createHash } from "node:crypto";
import { readShiftEntries } from "./shift-entries.mjs";
import { registerEvalScript } from "../lib/lua-scripts.mjs";

// Compare the slot and durable ended marker inside the same Redis operation.
const OPEN_STATE_LUA = `-- refresh shared shift without replacing a newer owner
local mode, shift, value, ttl = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local raw = redis.call('GET', KEYS[1])
local cur = raw and cjson.decode(raw) or nil
if mode == 'end' then
  redis.call('SET', KEYS[2], value, 'EX', ttl)
  if cur and cur.shift == shift then
    cur.ended = true
    cur.ended_at = cjson.decode(value).ended_at
    redis.call('SET', KEYS[1], cjson.encode(cur), 'EX', ttl)
  end
  return 1
end
if redis.call('GET', KEYS[2]) then return 0 end
if cur and (cur.shift ~= shift or cur.ended) then return 0 end
local next = cjson.decode(value)
if cur and tonumber(cur.last_seen) and tonumber(cur.last_seen) > tonumber(next.last_seen) then
  next.last_seen = cur.last_seen
end
redis.call('SET', KEYS[1], cjson.encode(next), 'EX', ttl)
return 1`;
registerEvalScript(OPEN_STATE_LUA, (call, keys, [mode, shift, value, ttl]) => {
  const raw = call('GET', keys[0]);
  const cur = raw ? JSON.parse(raw) : null;
  if (mode === 'end') {
    call('SET', keys[1], value, 'EX', ttl);
    if (cur?.shift === shift) {
      call('SET', keys[0], JSON.stringify({ ...cur, ended: true, ended_at: JSON.parse(value).ended_at }), 'EX', ttl);
    }
    return 1;
  }
  if (call('GET', keys[1]) || (cur && (cur.shift !== shift || cur.ended))) return 0;
  const next = JSON.parse(value);
  if (cur && Number(cur.last_seen) > Number(next.last_seen)) next.last_seen = cur.last_seen;
  call('SET', keys[0], JSON.stringify(next), 'EX', ttl);
  return 1;
}, { jail: true });

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
    const rec = tryParse(await store.redis("GET", key)) || null;
    if (!rec || rec.ended || !validAgent(rec.agent)) return rec;
    const ended = tryParse(await store.redis("GET", endedKey(rec.shift)));
    // A per-shift marker survives replacement of the shared open slot.
    if (ended) return { ...rec, ended: true, ended_at: ended.ended_at };
    const open = await loadOpen(rec.agent);
    if (open && open.shift !== rec.shift && open.started_at >= rec.started_at) {
      return { ...rec, ended: true, ended_at: open.started_at };
    }
    return rec;
  }
  async function save(rec) {
    await store.redis("SET", key, JSON.stringify(rec));
    await store.redis("EXPIRE", key, SESSION_TTL_S);
    return rec;
  }

  // ─── The agent's open shift on this surface, shared across session ids ───
  const surfaceSlug = slug(surface) || "unknown";
  const openKey = (agent) => lmSessionKey(store.space, sessionKeyPart(`open-shift-${agent}-${surfaceSlug}`));
  const openLockKey = (agent) => lmSessionKey(store.space, sessionKeyPart(`open-shift-lock-${agent}-${surfaceSlug}`));
  const endedKey = (shift) => lmSessionKey(store.space, sessionKeyPart(`ended-shift-${shift}`));
  const isLive = (r, t) => !!r && !r.ended && t - r.last_seen <= idleMs;

  async function loadOpen(agent) {
    const r = tryParse(await store.redis("GET", openKey(agent)));
    if (!r || typeof r !== "object" || r.agent !== agent || typeof r.shift !== "string") return null;
    const ended = tryParse(await store.redis("GET", endedKey(r.shift)));
    return ended ? { ...r, ended: true, ended_at: ended.ended_at } : r;
  }
  async function saveOpen(rec) {
    const k = openKey(rec.agent);
    const { agent, shift, started_at, last_seen, auto, ended, ended_at } = rec;
    await store.redis("SET", k, JSON.stringify({ agent, surface, shift, started_at, last_seen, auto, ...(ended ? { ended, ended_at } : {}) }));
    await store.redis("EXPIRE", k, SESSION_TTL_S);
  }
  /** Mark the open shift ended when it is this one, so no other session recaps or resumes it. */
  async function endOpen(rec, t) {
    await store.redis("EVAL", OPEN_STATE_LUA, 2, openKey(rec.agent), endedKey(rec.shift),
      "end", rec.shift, JSON.stringify({ ended_at: t }), String(SESSION_TTL_S));
  }
  /** Refresh only if this shift still owns the slot and has not ended. */
  async function touchOpen(rec, t) {
    const next = { ...rec, last_seen: t };
    return Number(await store.redis("EVAL", OPEN_STATE_LUA, 2, openKey(rec.agent), endedKey(rec.shift),
      "refresh", rec.shift, JSON.stringify(next), String(SESSION_TTL_S))) === 1;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * Run fn while holding a short lock on the agent's open-shift slot, so two
   * concurrent stateless calls start one shift, not two. A caller that cannot
   * get the lock waits for the holder's shift and resumes it. If the lock
   * stays taken, it runs fn anyway: a slow peer must never fail the call.
   */
  async function withOpenLock(agent, fn, onWaitResume) {
    const lk = openLockKey(agent);
    const token = randomBytes(8).toString("hex");
    for (let i = 0; i < 8; i++) {
      if ((await store.redis("SET", lk, token, "NX", "EX", "5")) != null) {
        try {
          return await fn();
        } finally {
          try {
            if ((await store.redis("GET", lk)) === token) await store.redis("DEL", lk);
          } catch {
            // the lock expires on its own (EX)
          }
        }
      }
      await sleep(50 * (i + 1));
      const cur = await loadOpen(agent);
      if (isLive(cur, now())) return onWaitResume(cur);
    }
    return fn();
  }

  /** Resume the agent's open shift on this surface, or auto Start one. */
  async function resumeOrStart(agent, events) {
    const resume = (open) => {
      events.push({ type: "resume", agent, shift: open.shift });
      return { agent, surface, shift: open.shift, started_at: open.started_at, last_seen: open.last_seen, auto: !!open.auto };
    };
    const open = await loadOpen(agent);
    if (isLive(open, now())) return resume(open);
    return withOpenLock(agent, async () => {
      const t = now();
      const cur = await loadOpen(agent);
      if (isLive(cur, t)) return resume(cur);
      if (cur && !cur.ended) {
        // Its sessions went quiet and none came back: recap it here.
        const r = await recapShift(cur, { reason: "idle", skipEmpty: true });
        if (r) events.push({ type: "auto-recap", agent, shift: cur.shift });
        await endOpen(cur, t);
      }
      const rec = await startShift(agent, { auto: true });
      events.push({ type: "auto-start", agent, shift: rec.shift });
      return rec;
    }, resume);
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
  async function recapShift(rec, { reason, notes, next, skipEmpty = false } = {}) {
    const agent = rec.agent;
    const since = rec.started_at;
    const ts = now();
    const { entries: mine, coverage, read_errors } = await readShiftEntries(store, {
      agent, shift: rec.shift, sinceMs: since, untilMs: ts,
    });
    // An automatic Recap is noise when the shift wrote nothing but its start, or
    // nothing since its last Recap (another session already recapped it). Only
    // when every log was read: a partial read must never hide real work.
    if (skipEmpty && !notes && coverage === "complete" && (mine.every((e) => e.kind === "started") || mine.at(-1)?.kind === "recap")) return null;
    const kinds = {};
    for (const e of mine) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    const recap = {
      agent,
      shift: rec.shift,
      mode: notes ? "manual" : "auto",
      reason: reason || (notes ? "recap" : "idle"),
      started_at: since,
      ended_at: ts,
      surface: rec.surface,
      summary: notes || `${coverage === "partial" ? "Partial recap: at least " : ""}${mine.length} entries this shift${mine.length ? `: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}` : ""}.`,
      entry_count: mine.length,
      entry_kinds: kinds,
      coverage,
      read_errors,
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

  /** Managed starts pass write admission before metadata. Other auto starts are metadata only. */
  async function startShift(agent, { auto = false, modelId } = {}) {
    const a = checkAgentId(String(agent));
    const ts = now();
    const shift = `${a}Shift-${ts}-${randomBytes(12).toString("hex")}`;
    const rec = { agent: a, surface, shift, started_at: ts, last_seen: ts, auto };
    if (!auto || store.managedLimits) await store.append("agent", a, {
      ts,
      kind: "started",
      by: agentRef(a),
      via: surface,
      byline: byline(a, surface),
      trail: shift,
      shift,
      summary: `${byline(a, surface)} started a shift`,
    });
    await store.addShift(a, { ts, shift, session_id: sessionId, surface, model_id: modelId || "unknown", auto, mirror: store.mirror ? "on" : "off" });
    await save(rec);
    await saveOpen(rec);
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
      let open = null;
      if (rec && !rec.ended) {
        open = await loadOpen(rec.agent);
        const same = open && open.shift === rec.shift;
        if (same && open.ended) {
          // Another session already recapped or ended this shift.
          rec = await save({ ...rec, ended: true, ended_at: open.ended_at ?? t });
        } else if (t - Math.max(rec.last_seen, same ? Number(open.last_seen) || 0 : 0) > idleMs) {
          const r = await recapShift(rec, { reason: "idle", skipEmpty: true });
          if (r) events.push({ type: "auto-recap", agent: rec.agent, shift: rec.shift });
          await endOpen(rec, t);
          rec = await save({ ...rec, ended: true, ended_at: t });
        }
      }
      if ((!rec || rec.ended) && toolName !== "logmem_start") {
        const agent = (rec && validAgent(rec.agent)) || fallbackAgent();
        rec = await resumeOrStart(agent, events);
        open = await loadOpen(agent);
      }
      if (rec && !rec.ended) {
        rec = await save({ ...rec, last_seen: t });
        if (!await touchOpen(rec, t)) {
          rec = await resumeOrStart(rec.agent, events);
          rec = await save({ ...rec, last_seen: t });
        }
      }
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
          const t = now();
          await save({ ...rec, last_seen: t });
          if (!await touchOpen(rec, t)) {
            const current = await resumeOrStart(a, events);
            await save(current);
            return { shift: current, events };
          }
          return { shift: rec, events: [{ type: "already-started", agent: a, shift: rec.shift }] };
        }
        const recap = await recapShift(rec, { reason: `switch to ${a}` });
        events.push({ type: "switch-recap", agent: rec.agent, shift: rec.shift, recap });
        await endOpen(rec, now());
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
      if (end) {
        await endOpen(rec, now());
        await save({ ...rec, ended: true, ended_at: now() });
      }
      return recap;
    },

    /** stdio timer: write the idle Recap without waiting for the next call. */
    async sweep() {
      const rec = await load();
      if (rec && !validAgent(rec.agent)) return false;
      if (rec && locked && rec.agent !== locked) return false;
      if (!rec || rec.ended) return false;
      const open = await loadOpen(rec.agent);
      const same = open && open.shift === rec.shift;
      if (same && open.ended) {
        await save({ ...rec, ended: true, ended_at: open.ended_at ?? now() });
        return false;
      }
      // Another session on this surface may still be using the shift.
      if (now() - Math.max(rec.last_seen, same ? Number(open.last_seen) || 0 : 0) <= idleMs) return false;
      await recapShift(rec, { reason: "idle", skipEmpty: true });
      await endOpen(rec, now());
      await save({ ...rec, ended: true, ended_at: now() });
      return true;
    },
  };
}
