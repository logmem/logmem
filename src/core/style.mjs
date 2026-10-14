// style.mjs — the LogMem plain-writing check (docs/spec/WRITING.md).
//
// Based on ASD-STE100 Simplified Technical English. It never blocks a write:
// the result of a write carries `style.warnings` so the agent can fix its
// next entry. Text inside `backticks` is skipped, so ids, trails and commands
// never trigger a rule.

export const STYLE_STANDARD = "logmem-plain-v1";
export const MAX_SENTENCE_WORDS = 25;

const WEAK_MODALS = /\b(should|would|may|might|could)\b/i;
// Passive heuristic: a form of "be", a past participle, then a clause end or a
// preposition ("was merged.", "is sent to Mikey", "were fixed by atlas").
// "is shared memory" (participle used as an adjective before a noun) is not flagged.
const PASSIVE = /\b(is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?(\w+ed|done|made|sent|built|written|given|taken|seen|shown|known|set|put|run|kept|left|found|held|told|paid|lost|won|split|cut)(?=\s*(?:[.,;:!?)]|$)|\s+(?:by|to|in|on|for|at|from|with|into|onto|after|before|during|yet|already|today|now|and|or|but)\b)/i;
const FILLER = /\b(delve|tapestry|testament|leverage[ds]?|robust|seamless(?:ly)?|synergy|game[- ]changer|in order to|it'?s worth noting|please note|i hope this|great question|needless to say|at the end of the day)\b/i;

/** Plain sentences: code spans removed, split on . ! ? followed by space or end. */
function sentences(text) {
  return String(text)
    .replace(/`[^`]*`/g, "X")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const words = (s) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));

/**
 * Check one entry summary. Returns [] when it reads clean.
 * Each warning: { rule, detail }. At most 5, most useful first.
 */
export function checkStyle(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const out = [];
  const plain = text.replace(/`[^`]*`/g, "X");
  for (const s of sentences(text)) {
    const n = words(s).length;
    const commas = (s.match(/,/g) || []).length;
    if (commas >= 4 && commas * 3 >= n) continue; // a list, not a sentence
    if (n > MAX_SENTENCE_WORDS) out.push({ rule: "long_sentence", detail: `${n} words. Keep sentences at ${MAX_SENTENCE_WORDS} words or fewer` });
  }
  const m = plain.match(WEAK_MODALS);
  if (m) out.push({ rule: "weak_modal", detail: `"${m[0]}": state it directly or give the condition` });
  const p = plain.match(PASSIVE);
  if (p) out.push({ rule: "passive_voice", detail: `"${p[0]}": name who did it` });
  const f = plain.match(FILLER);
  if (f) out.push({ rule: "filler", detail: `"${f[0]}": cut it` });
  if (/[—–]/.test(plain)) out.push({ rule: "dash", detail: "use a period or a comma, not a dash" });
  if (/;/.test(plain)) out.push({ rule: "semicolon", detail: "split it into two sentences" });
  return out.slice(0, 5);
}

/** The style block for a write result, or null when the summary reads clean. */
export function styleFor(summary) {
  const warnings = checkStyle(summary);
  return warnings.length ? { standard: STYLE_STANDARD, warnings } : null;
}
