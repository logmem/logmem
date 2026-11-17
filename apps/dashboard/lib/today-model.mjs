// apps/dashboard/lib/today-model.mjs
// Pure helpers for the Today screen. No React, no network. The root test
// suite imports this file, so it stays plain JavaScript.
// Input is the home view from src/http/view.mjs. Nothing here invents a row:
// every count and line comes from that view.

const text = (v) => (typeof v === "string" ? v.trim() : "");

/** The four summary counts. Done counts work jobs across the plans in the view. */
export function todayCounts(view) {
  const items = Array.isArray(view?.needs_items) ? view.needs_items : [];
  const plans = Array.isArray(view?.plans) ? view.plans : [];
  return {
    decisions: items.filter((i) => i.type === "decision").length,
    tasks: items.filter((i) => i.type === "task").length,
    waiting: Array.isArray(view?.blocked) ? view.blocked.length : 0,
    done: plans.reduce((n, p) => n + (Number(p.done) || 0), 0),
    jobs: plans.reduce((n, p) => n + (Number(p.jobs) || 0), 0),
  };
}

const KIND_LABEL = { decision: "Decision", task: "Task", suggestion: "Looks done?" };

/** One line per item that needs this person. Keeps the order the view gives. */
export function needsRows(view) {
  const items = Array.isArray(view?.needs_items) ? view.needs_items : [];
  return items.map((i) => ({
    key: String(i.trail || `${i.type}:${i.job || ""}`),
    type: String(i.type || "item"),
    label: KIND_LABEL[i.type] || "Item",
    summary: text(i.summary) || "No summary recorded.",
    job: text(i.job) || null,
    plan: text(i.plan) || null,
    by: text(i.by) || text(i.owner) || null,
    due: i.due ? String(i.due) : null,
    createdAt: Number.isFinite(Number(i.created_at)) && Number(i.created_at) > 0 ? Number(i.created_at) : null,
    progress: i.type === "task" && Number(i.steps) > 0 ? `${Number(i.steps_done) || 0}/${Number(i.steps)}` : null,
  }));
}

/** What a blocked job waits on, in words. Never guesses a reason. */
export function blockedReason(blockedOn) {
  if (!blockedOn) return "No reason recorded.";
  if (typeof blockedOn === "string") return text(blockedOn) || "No reason recorded.";
  const note = text(blockedOn.note);
  const ref = text(blockedOn.ref);
  const type = text(blockedOn.type);
  if (note) return note;
  if (type && ref) return `Waits on ${type} ${ref}.`;
  if (ref) return `Waits on ${ref}.`;
  if (type) return `Waits on a ${type}.`;
  return "No reason recorded.";
}

export function blockedRows(view, limit = 8) {
  const rows = Array.isArray(view?.blocked) ? view.blocked : [];
  return rows.slice(0, limit).map((b) => ({
    key: String(b.id),
    title: text(b.title) || String(b.id),
    owner: text(b.owner) || null,
    plan: text(b.plan) || null,
    reason: blockedReason(b.blocked_on),
    since: Number.isFinite(Number(b.since)) && Number(b.since) > 0 ? Number(b.since) : null,
  }));
}

export function recentRows(view, limit = 12) {
  const rows = Array.isArray(view?.recent) ? view.recent : [];
  return rows.slice(0, limit).map((e, n) => ({
    key: `${e.trail || "entry"}:${e.ts}:${n}`,
    summary: text(e.summary) || "No summary recorded.",
    by: text(e.by) || null,
    where: text(e.where) || null,
    kind: text(e.kind) || null,
    ts: Number(e.ts),
  }));
}

/** Read problems the view reported. The screen shows the count, never hides it. */
export function coverageNotice(view) {
  const errors = Array.isArray(view?.coverage?.errors) ? view.coverage.errors.length : 0;
  if (!errors) return null;
  return `${errors} ${errors === 1 ? "record" : "records"} could not be read. Counts can be low.`;
}
