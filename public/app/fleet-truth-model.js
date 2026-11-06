// fleet-truth-model.js — pure reading rules for the fleet-truth board (no imports, so tests can load it).
// Spec: docs/superpowers/specs/2026-11-06-fleet-truth-seed-ui-design.md, approach A, parts 2 and 4.
// The viewer never changes a row's tag and never hides a row. A field the data lacks is not drawn.

export const CHANNEL_ID = 'fleet-truth';
export const SCHEMA = 'fleet-truth/v1';
/** The collector's default window (FRESHNESS_MS in src/fleet-truth/build.mjs). Labelled "default window" on screen. */
export const FRESH_MS = 36 * 3600e3;

export const SECTION_DEFS = [
  { key: 'clock', label: 'Clock', open: false },
  { key: 'lanes', label: 'Lanes', open: false },
  { key: 'launch', label: 'Launch', open: false },
  { key: 'blockers', label: 'Blockers', open: true },
  { key: 'infra', label: 'Infra', open: true },
  { key: 'agents', label: 'Agents', open: false },
  { key: 'deltas', label: 'Deltas', open: false },
];

/** Word and icon per tag. Icons all exist in public/ds/components/bundle.css. */
export const TAGS = {
  verified: { word: 'Verified', icon: 'check', tip: 'Checked at the source in this refresh.' },
  reported: { word: 'Reported', icon: 'handoff', tip: 'Carried from another agent. Not re-checked.' },
  unknown: { word: 'Unknown', icon: 'alert', tip: 'Input missing or probe failed.' },
  stale: { word: 'Stale', icon: 'clock', tip: 'Past its freshness window. Not re-checked.' },
};
export const TAG_ORDER = ['verified', 'reported', 'unknown', 'stale'];

const SLOT_WORDS = { morning: 'Morning refresh', midday: 'Midday refresh', closeout: 'Closeout refresh', manual: 'Manual refresh' };
export const slotLabel = (slot) => (slot ? SLOT_WORDS[String(slot)] || String(slot) + ' refresh' : '');

// Same patterns as scrubSecrets in src/fleet-truth/schema.mjs. A value that matches is never drawn.
const SECRET_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|(?:redis|rediss):\/\/[^/@\s]+:[^@/\s]+@[^\s]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i;
export const looksSecret = (v) => typeof v === 'string' && SECRET_RE.test(v);
export const REDACTED = 'Redacted by viewer';
/** Text for screen: a string that looks like a secret becomes a fixed notice. */
export const safeText = (v) => (looksSecret(v) ? REDACTED : v);

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/** One Fact row, with defaults from Part 4. */
export function normalizeFact(raw) {
  const f = isObj(raw) ? raw : {};
  const given = str(f.status);
  const known = Object.prototype.hasOwnProperty.call(TAGS, given);
  const tag = known ? given : 'unknown';
  const source = str(f.source);
  const verifiedBy = str(f.verified_by);
  const redacted = [f.claim, f.source, f.verified_by].some(looksSecret);
  return {
    claim: redacted && looksSecret(f.claim) ? REDACTED : str(f.claim) || 'Claim text missing',
    tag,
    // An unknown tag value is shown, never hidden.
    oddTag: given && !known ? given : '',
    observedAt: str(f.observed_at),
    source: looksSecret(f.source) ? REDACTED : source,
    sourceUrl: /^https:\/\//i.test(source) && !looksSecret(source) && !/\s/.test(source) ? source : '',
    verifiedBy: looksSecret(f.verified_by) ? REDACTED : verifiedBy,
    // A verified row with no recorded checker is a warning, not an error.
    verifiedByMissing: tag === 'verified' && !verifiedBy,
    redacted,
  };
}

/** The P0, blocker and infra parts of the Now summary line. Parts the line lacks are left out. */
export function summaryChips(summary) {
  const out = [];
  for (const part of String(summary || '').split('|')) {
    const m = /^\s*(P0|top_blocker|infra)\s*=\s*(.+?)\s*$/.exec(part);
    if (!m) continue;
    const label = { P0: 'P0', top_blocker: 'Top blocker', infra: 'Infra' }[m[1]];
    out.push({ label, value: safeText(m[2]) });
  }
  return out;
}

/** Facts a section holds, and whether the section was in the payload at all. */
function sectionOf(board, key) {
  const sec = board[key];
  const present = Boolean(isObj(sec) && Array.isArray(sec.items));
  return { key, present, facts: present ? sec.items.map(normalizeFact) : [] };
}

/**
 * Read a channel Now into a board.
 * state: 'empty' (no Now), 'schema' (Now exists but is not fleet-truth/v1), 'ok'.
 * The collector stores the board under now.board with summary beside it. A flat payload also works.
 */
export function readBoard(now, nowMs = Date.now()) {
  if (!isObj(now) || !Object.keys(now).length) return { state: 'empty' };
  const board = isObj(now.board) ? now.board : now;
  const schema = str(board.schema) || str(now.schema);
  if (schema !== SCHEMA) return { state: 'schema', schema: schema || 'not recorded' };
  const refreshedAt = str(board.refreshed_at) || str(now.refreshed_at);
  const refreshedMs = Date.parse(refreshedAt);
  const ageMs = Number.isFinite(refreshedMs) ? nowMs - refreshedMs : null;
  const sections = SECTION_DEFS.map((d) => ({ ...d, ...sectionOf(board, d.key) }));
  const counts = Object.fromEntries(TAG_ORDER.map((t) => [t, 0]));
  for (const s of sections) for (const f of s.facts) counts[f.tag]++;
  const summary = str(now.summary) || str(board.summary);
  return {
    state: 'ok',
    schema,
    refreshedAt,
    refreshedMs: Number.isFinite(refreshedMs) ? refreshedMs : null,
    slot: str(board.slot) || str(now.slot),
    runner: str(board.runner) || str(now.runner),
    trail: str(board.trail) || str(now.trail),
    summary: safeText(summary),
    chips: summaryChips(summary),
    // No refresh time, or a time past the window, counts as stale. Row tags stay as the collector wrote them.
    stale: ageMs == null || ageMs > FRESH_MS,
    sections,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

/** Keep a section's facts whose tag is switched on. */
export const visibleFacts = (facts, on) => facts.filter((f) => on[f.tag]);

/** Ready-made correction text for the copy fallback. It writes nothing; a person pastes it as a memo. */
export function correctionText(fact, trail) {
  return [
    'Proposed correction for channel:fleet-truth' + (trail ? ' (' + trail + ')' : ''),
    'Claim: ' + fact.claim,
    'Shown as: ' + fact.tag + (fact.source ? ', source ' + fact.source : ''),
    'What is wrong: ',
    'Evidence: ',
    'Source: ',
  ].join('\n');
}
