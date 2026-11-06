// log-model.js — pure helpers for the Log inspector, grouping, shift markers and Recall highlights.
// No imports, so node tests can load it. Every field read has a default: the server may omit any of them.
export const GROUP_BY = [['time', 'Time'], ['trail', 'Trail'], ['shift', 'Shift']];
export const SHIFT_GAP_MS = 30 * 60 * 1000;
const s = (v) => (v == null ? '' : String(v));
const t = (e) => (Number.isFinite(Number(e && e.ts)) ? Number(e.ts) : 0);
const who = (e) => s(e && e.by).replace(/^agent:/, '').replace(/^human:/, '') || 'unknown';

export const groupByMode = (v) => (GROUP_BY.some(([k]) => k === v) ? v : 'time');
/** A stable key for one entry. Trail alone repeats along a chain, so the time and writer join it. */
export const entryKey = (e) => [s(e && e.trail), t(e), s(e && e.by), s(e && e.kind)].join('|');

/** Entries on the same trail as `sel`, plus the origin chain behind it and the entries that follow from it. Oldest first. */
export function trailChain(all, sel) {
  const list = Array.isArray(all) ? all : [];
  if (!sel) return [];
  const trails = new Set(), origins = new Set();
  if (sel.trail) trails.add(s(sel.trail));
  // Walk origins backward (bounded) so the chain reaches the first assignment.
  let cur = s(sel.origin), hops = 0;
  while (cur && hops++ < 12 && !trails.has(cur)) {
    trails.add(cur);
    const parent = list.find((e) => s(e.trail) === cur && e.origin);
    cur = parent ? s(parent.origin) : '';
  }
  if (sel.trail) origins.add(s(sel.trail));
  const rows = list.filter((e) => trails.has(s(e.trail)) || (e.origin && origins.has(s(e.origin))));
  if (!rows.some((e) => entryKey(e) === entryKey(sel))) rows.push(sel);
  return rows.slice().sort((a, b) => t(a) - t(b));
}

/** Split a list into shift runs: same writer, gap under 30 minutes. Input order is newest first; output keeps it. */
export function shiftRuns(list, gap = SHIFT_GAP_MS) {
  const rows = Array.isArray(list) ? list : [];
  const byAgent = new Map();
  for (const e of rows) { const a = who(e); (byAgent.get(a) || byAgent.set(a, []).get(a)).push(e); }
  const runs = [];
  for (const [agent, mine] of byAgent) {
    const asc = mine.slice().sort((a, b) => t(a) - t(b));
    let run = null;
    for (const e of asc) {
      if (!run || t(e) - t(run.entries[run.entries.length - 1]) > gap) { run = { agent, entries: [] }; runs.push(run); }
      run.entries.push(e);
    }
  }
  for (const r of runs) { r.start = t(r.entries[0]); r.end = t(r.entries[r.entries.length - 1]); r.lastKind = s(r.entries[r.entries.length - 1].kind); }
  // carried: the same writer's previous run ended with a recap. cold: it did not. first: no earlier run in this window.
  for (const r of runs) {
    const prev = runs.filter((o) => o.agent === r.agent && o !== r && o.end <= r.start).sort((a, b) => b.end - a.end)[0];
    r.state = !prev ? 'first' : prev.lastKind === 'recap' ? 'carried' : 'cold';
  }
  for (const r of runs) r.entries.reverse();
  return runs.sort((a, b) => b.end - a.end);
}

/** Rows for the list. Each row is {type:'shift',...}, {type:'head',...} or {type:'entry',e}. */
export function logRows(list, mode) {
  const rows = (Array.isArray(list) ? list : []).slice().sort((a, b) => t(b) - t(a));
  const m = groupByMode(mode);
  const out = [];
  if (m === 'trail') {
    const groups = new Map();
    for (const e of rows) { const k = s(e.trail) || 'no trail'; (groups.get(k) || groups.set(k, []).get(k)).push(e); }
    for (const [k, es] of groups) { out.push({ type: 'head', label: k, count: es.length }); for (const e of es) out.push({ type: 'entry', e }); }
    return out;
  }
  const runs = shiftRuns(rows);
  if (m === 'shift') {
    for (const r of runs) { out.push({ type: 'shift', agent: r.agent, state: r.state, start: r.start, count: r.entries.length }); for (const e of r.entries) out.push({ type: 'entry', e }); }
    return out;
  }
  // Time: one flat list, a marker wherever the writer or the shift changes.
  const owner = new Map();
  for (const r of runs) for (const e of r.entries) owner.set(e, r);
  let last = null;
  for (const e of rows) {
    const r = owner.get(e);
    if (r && r !== last) { out.push({ type: 'shift', agent: r.agent, state: r.state, start: r.start, count: r.entries.length }); last = r; }
    out.push({ type: 'entry', e });
  }
  return out;
}

export const SHIFT_NOTE = { carried: 'carried forward: Recap before this shift', cold: 'started cold (no Recap before it)', first: 'first shift in this window' };

/** Words of a recall query worth highlighting. */
export function matchTerms(q) {
  return [...new Set(s(q).toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1))];
}
/** Which of the terms appear in the text. */
export const matchedTerms = (text, terms) => { const low = s(text).toLowerCase(); return (terms || []).filter((w) => low.includes(w)); };
/** Split text into [{text, hit}] parts so a view can wrap hits in <mark>. */
export function highlightParts(text, terms) {
  const str = s(text), ws = (terms || []).filter(Boolean);
  if (!ws.length) return [{ text: str, hit: false }];
  const re = new RegExp('(' + ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return str.split(re).filter((p) => p !== '').map((p) => ({ text: p, hit: ws.some((w) => w.toLowerCase() === p.toLowerCase()) }));
}
/** Read a recall result with defaults. */
export function recallRow(r) {
  const x = r && typeof r === 'object' ? r : {};
  return { kind: s(x.kind) || 'entry', summary: s(x.summary), from: s(x.from), trail: s(x.trail), ts: Number(x.ts) || 0, by: s(x.by).replace(/^agent:/, '') };
}
/** Raw fields for the Tech view, only the ones the server sent. */
export function techFields(e) {
  const x = e && typeof e === 'object' ? e : {};
  const out = {};
  for (const k of ['kind', 'group', 'by', 'via', 'where', 'trail', 'origin', 'to', 'shift', 'ts', 'legacy', 'unverified', 'ask_digest', 'payload']) if (x[k] != null) out[k] = x[k];
  return out;
}
export const jobIdOf = (where) => (/^job:/.test(s(where)) ? s(where).slice(4) : '');
