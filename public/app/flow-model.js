// flow-model.js — pure helpers for the four data views: handoff map, time scrubber, fleet pulse, blocker map.
// No DOM here. Every function takes plain rows from the view API and returns plain data, so node can test it.
import { blockerNote } from './dashboard-model.js';

const H = 3600000, DAY = 86400000;
const bare = id => String(id ?? '').replace(/^(agent|human):/, '');

// ---- Handoff map ----
/** Age band: fresh under 1 day, slow to 7 days, stale after that. */
export const ageBand = days => (days > 7 ? 'stale' : days > 1 ? 'slow' : 'fresh');
export function ageLabel(ms) {
  const d = ms / DAY;
  return d >= 1 ? Math.round(d) + ' d' : Math.max(1, Math.round(ms / H)) + ' h';
}
/** Coordination queue items become arcs between agents. Only items with a sender and a receiver draw. */
export function handoffArcs(items = [], now = Date.now()) {
  return items
    .map(it => {
      const from = bare(it.from), to = bare(it.to), born = Number(it.created_at);
      if (!from || !to || from === to || !Number.isFinite(born) || born > now) return null;
      const age = now - born;
      return { trail: it.trail ?? it.request_trail ?? `${from}>${to}>${born}`, from, to, age, band: ageBand(age / DAY), label: ageLabel(age), summary: String(it.summary ?? '') };
    })
    .filter(Boolean)
    .sort((a, b) => b.age - a.age);
}
export const arcAgents = arcs => [...new Set(arcs.flatMap(a => [a.from, a.to]))].sort();
/** Arcs that start or end at agent. An empty agent keeps every arc. */
export const involves = (arc, agent) => !agent || arc.from === agent || arc.to === agent;
/** Queue items for one agent, or for one sender and receiver pair. Pair wins over agent. */
export function matchHandoff(item, agent = '', pair = null) {
  const from = bare(item.from), to = bare(item.to);
  if (pair) return from === pair.from && to === pair.to;
  return !agent || from === agent || to === agent;
}
/** Per agent: how many handoffs wait on it, and how many of those are past a day. */
export function waitingOn(arcs) {
  const by = new Map();
  for (const a of arcs) {
    const w = by.get(a.to) || { count: 0, late: 0 };
    w.count++;
    if (a.band !== 'fresh') w.late++;
    by.set(a.to, w);
  }
  return by;
}
/** Sender by receiver grid. Each cell holds the count and the band of its oldest handoff. */
export function handoffMatrix(arcs) {
  const cells = new Map();
  for (const a of arcs) {
    const key = a.from + '>' + a.to, c = cells.get(key) || { from: a.from, to: a.to, count: 0, age: 0, band: 'fresh', label: '' };
    c.count++;
    if (a.age >= c.age) { c.age = a.age; c.band = a.band; c.label = a.label; }
    cells.set(key, c);
  }
  return { names: arcAgents(arcs), cells };
}
/** Place n nodes on a circle, first one at the top. */
export function ringPoints(n, cx, cy, r) {
  return Array.from({ length: n }, (_, i) => {
    const t = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1);
    return { x: Math.round(cx + r * Math.cos(t)), y: Math.round(cy + r * Math.sin(t)) };
  });
}
/** A curve that bows toward the centre so two opposite arcs do not overlap. inset stops the end short of a node, so its arrowhead stays visible. */
export function arcPath(p, q, cx, cy, pull = 0.35, inset = 0) {
  const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, kx = mx + (cx - mx) * pull, ky = my + (cy - my) * pull;
  const d = Math.hypot(q.x - kx, q.y - ky) || 1, ex = q.x + ((kx - q.x) / d) * inset, ey = q.y + ((ky - q.y) / d) * inset;
  return `M${p.x} ${p.y} Q${Math.round(kx)} ${Math.round(ky)} ${Math.round(ex)} ${Math.round(ey)}`;
}

// ---- Time scrubber ----
const GROUPS = ['handoff', 'approval', 'stuck', 'done', 'progress'];
/** Entries with a real timestamp, oldest first. Anything future or invalid is dropped. */
export function replayEntries(entries = [], now = Date.now()) {
  return entries.filter(e => Number.isFinite(Number(e.ts)) && Number(e.ts) <= now).map(e => ({ ...e, ts: Number(e.ts) })).sort((a, b) => a.ts - b.ts);
}
export function replayBounds(sorted) {
  if (!sorted.length) return null;
  return { start: sorted[0].ts, end: sorted[sorted.length - 1].ts };
}
/** The log as it stood at time t: counts by kind and the last five entries, newest first. */
export function replayAt(sorted, t) {
  const seen = sorted.filter(e => e.ts <= t);
  const counts = Object.fromEntries(GROUPS.map(k => [k, 0]));
  for (const e of seen) if (e.kind in counts) counts[e.kind]++;
  return { total: seen.length, counts, last: seen.slice(-5).reverse() };
}
/** Slider value 0..max to a timestamp inside the bounds. */
export const atFraction = (bounds, f) => Math.round(bounds.start + (bounds.end - bounds.start) * Math.min(1, Math.max(0, f)));

// ---- Fleet pulse ----
export const QUIET_HOURS = 6, SHIFT_GAP_MS = 45 * 60000;
/** One lane per agent over the window. Bars are runs of entries less than 45 minutes apart. */
export function pulseLanes(entries = [], windowHours = 24, now = Date.now(), agents = []) {
  const from = now - windowHours * H, by = new Map(agents.map(id => [bare(id), []]));
  for (const e of entries) {
    const ts = Number(e.ts), who = bare(e.by);
    if (!who || !Number.isFinite(ts) || ts > now || ts < from) continue;
    if (!by.has(who)) by.set(who, []);
    by.get(who).push({ ts, kind: e.kind });
  }
  const pos = ts => ((ts - from) / (now - from)) * 100;
  return [...by].map(([id, rows]) => {
    rows.sort((a, b) => a.ts - b.ts);
    const runs = [];
    for (const r of rows) {
      const last = runs[runs.length - 1];
      if (last && r.ts - last.end <= SHIFT_GAP_MS) { last.end = r.ts; last.n++; }
      else runs.push({ start: r.ts, end: r.ts, n: 1 });
    }
    const quiet = [];
    let cursor = from;
    for (const run of runs.concat([{ start: now, end: now }])) {
      if (run.start - cursor >= QUIET_HOURS * H) quiet.push({ start: cursor, end: run.start, hours: Math.round((run.start - cursor) / H) });
      cursor = Math.max(cursor, run.end);
    }
    const lastTs = rows.length ? rows[rows.length - 1].ts : null, ago = lastTs == null ? null : now - lastTs;
    return {
      id, empty: !rows.length,
      count: rows.length,
      bars: runs.map(r => ({ left: pos(r.start), width: Math.max(pos(r.end) - pos(r.start), 0.8), n: r.n, level: r.n >= 5 ? 'many' : r.n >= 2 ? 'few' : 'one' })),
      recaps: rows.filter(r => r.kind === 'recap').map(r => pos(r.ts)),
      quiet: quiet.map(q => ({ left: pos(q.start), width: pos(q.end) - pos(q.start), hours: q.hours })),
      state: lastTs == null ? 'No entries in this window' : ago < 15 * 60000 ? 'Wrote just now' : ago < H ? `Quiet ${Math.round(ago / 60000)} m` : `Quiet ${Math.round(ago / H)} h`,
      live: ago != null && ago < 15 * 60000,
      status: lastTs == null ? 'empty' : ago < 15 * 60000 ? 'live' : ago >= QUIET_HOURS * H ? 'long' : 'quiet',
    };
  }).sort((a, b) => Number(a.empty) - Number(b.empty) || (b.live - a.live) || a.id.localeCompare(b.id));
}
/** Lane counts for the filter pills. Live is a subset of active. */
export function laneCounts(lanes) {
  return { all: lanes.length, live: lanes.filter(l => l.live).length, quiet: lanes.filter(l => !l.empty && !l.live).length, active: lanes.filter(l => !l.empty).length, empty: lanes.filter(l => l.empty).length };
}
/** Which lanes a view shows inline. Active hides the empty ones, which the page tucks in a drawer. */
export function laneView(lanes, show) {
  if (show === 'all') return lanes;
  if (show === 'live') return lanes.filter(l => l.live);
  if (show === 'quiet') return lanes.filter(l => !l.empty && !l.live);
  return lanes.filter(l => !l.empty);
}
export function pulseAxis(windowHours, steps = 4) {
  return Array.from({ length: steps + 1 }, (_, i) => (i === steps ? 'now' : Math.round(windowHours - (i * windowHours) / steps) + ' h ago'));
}

// ---- Blocker map ----
export const KIND_LABEL = { person: 'Waiting on a person', vendor: 'Billing and infrastructure', agent: 'Agent handoffs' };
const PERSON_NOTE = /\b(waits?\s+for|needs?|awaiting)\s+(mikey|michael|a person|the operator|operator|a human|human|you)\b/i;
const VENDOR_NOTE = /\b(billing|payment|invoice|credits?|quota|subscription|plan limit|rate limit|tokens?|expired|expiry|api key|secret|oauth|infisical|vercel|github|openai|anthropic|stripe|clerk|dns|domain|certificate)\b/i;
/** A guess from the job's type and blocker text: person, vendor (billing or infrastructure) or agent. */
export function blockerKind(job) {
  const note = blockerNote(job);
  if (['task', 'decision'].includes(job.blocked_on?.type) || PERSON_NOTE.test(note)) return 'person';
  return VENDOR_NOTE.test(note) ? 'vendor' : 'agent';
}
export const STALL_DAYS = 3;
/** Jobs per kind, for the filter pills. */
export function kindCounts(clusters) {
  const n = { all: 0, person: 0, vendor: 0, agent: 0 };
  for (const c of clusters) { n.all += c.jobs.length; n[c.kind] += c.jobs.length; }
  return n;
}
/** Blocked jobs that wait on the same text become one bubble. Parked jobs are left out. */
export function blockerClusters(jobs = [], now = Date.now()) {
  const by = new Map();
  for (const j of jobs) {
    const note = blockerNote(j);
    if (!note) continue;
    const key = note.toLowerCase(), c = by.get(key) || { key, note, jobs: [], person: false };
    c.jobs.push(j);
    if (['task', 'decision'].includes(j.blocked_on?.type)) c.person = true;
    const k = blockerKind(j);
    c.kinds = c.kinds || new Set();
    c.kinds.add(k);
    const since = Number(j.since);
    if (Number.isFinite(since) && since > 0 && now - since > STALL_DAYS * DAY) c.late = true;
    by.set(key, c);
  }
  return [...by.values()].sort((a, b) => b.jobs.length - a.jobs.length || a.note.localeCompare(b.note)).map(c => ({ ...c, kind: c.kinds.has('person') ? 'person' : c.kinds.has('vendor') ? 'vendor' : 'agent', late: !!c.late, who: c.person ? 'person' : 'agent', radius: Math.round(22 + 8 * Math.sqrt(c.jobs.length)) }));
}
/** The text the Copy button puts on the clipboard. It starts nothing. */
export function unblockPrompt(cluster, space) {
  const ids = cluster.jobs.map(j => j.id);
  return [
    `[LogMem dispatch · space: ${space || 'unknown'}]`,
    `Blocked cluster (${ids.length} ${ids.length === 1 ? 'job' : 'jobs'}): ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', ...' : ''}`,
    `Blocker: "${cluster.note}"`,
    'Action: open each job, check whether the blocker has cleared, move it forward or post what is still missing, and record a receipt on each ref.',
  ].join('\n');
}
/** Bubble centres: a ring, biggest first, so labels never sit on the same spot. */
export function bubbleLayout(clusters, w, h) {
  const n = clusters.length, cx = w * 0.38, cy = h / 2, rx = w * 0.3, ry = h * 0.32;
  return clusters.map((c, i) => {
    const t = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1);
    return { ...c, x: Math.round(n === 1 ? cx : cx + rx * Math.cos(t)), y: Math.round(n === 1 ? cy : cy + ry * Math.sin(t)) };
  });
}
