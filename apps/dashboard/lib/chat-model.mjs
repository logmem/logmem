// apps/dashboard/lib/chat-model.mjs
// Read-only chat answers for one space. No model, no network, no writes.
// Every number and line comes from the home view (src/http/view.mjs) through
// today-model.mjs. A request that cannot be undone is never done here: it comes
// back as a proposed action that a person must approve, and approving it in
// this slice still runs nothing.

import { blockedRows, coverageNotice, needsRows, recentRows, todayCounts } from "./today-model.mjs";
import { shortName } from "./inbox-model.mjs";

export const CHAT_LIMITS = Object.freeze({ maxTurns: 20, maxChars: 2000 });

const IRREVERSIBLE = /\b(deploy|merge|send|email|delete|remove|publish|pay|refund|rotate|archive|close)\b/i;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Clean a client history: cap turns and length, force known roles. Returns null when unusable. */
export function cleanHistory(history) {
  if (!Array.isArray(history) || history.length === 0 || history.length > 50) return null;
  const turns = history.slice(-CHAT_LIMITS.maxTurns).map((m) => ({
    role: m?.role === "assistant" ? "assistant" : "user",
    text: String(m?.text ?? "").slice(0, CHAT_LIMITS.maxChars),
  }));
  return turns.some((m) => m.role === "user" && m.text.trim()) ? turns : null;
}

function lastQuestion(history) {
  return [...history].reverse().find((m) => m.role === "user")?.text.trim() ?? "";
}

function needsAnswer(view) {
  const c = todayCounts(view);
  const rows = needsRows(view);
  if (rows.length === 0) return "Nothing in this space needs you now.";
  const top = rows.slice(0, 3).map((r) => `${r.label}: ${r.summary}`).join(" ");
  const more = rows.length > 3 ? ` ${rows.length - 3} more are in the Inbox.` : "";
  return `${plural(rows.length, "item")} need you: ${plural(c.decisions, "decision")} and ${plural(c.tasks, "task")}. ${top}${more}`;
}

function blockedAnswer(view) {
  const c = todayCounts(view);
  const rows = blockedRows(view, 3);
  if (c.waiting === 0) return "No job in this space is blocked.";
  const top = rows.map((b) => `${b.title}: ${b.reason}`).join(" ");
  return `${plural(c.waiting, "job is", "jobs are")} blocked. ${top}`;
}

function workAnswer(view) {
  const c = todayCounts(view);
  return `This space has ${plural(c.jobs, "job")} in its plans. ${c.done} done and ${c.waiting} blocked. Open Work to see them all.`;
}

function recentAnswer(view) {
  const rows = recentRows(view, 3);
  if (rows.length === 0) return "No job in this space has an update yet.";
  return `Latest updates: ${rows.map((e) => `${e.by ? shortName(e.by) : "Someone"}: ${e.summary}`).join(" ")}`;
}

/**
 * Answer one question from the view.
 * Returns { text, action? }. action is a proposal only: { id, label, detail, reversible: false }.
 */
export function answer(history, view, now = Date.now()) {
  const q = lastQuestion(history);
  const notice = coverageNotice(view);
  const tail = notice ? ` ${notice}` : "";
  const verb = q.match(IRREVERSIBLE)?.[1]?.toLowerCase();
  if (verb) {
    return {
      text: `I will not ${verb} anything on my own, because it cannot be undone. Review the proposal below. In this version, approving it records your answer here and runs nothing.`,
      action: {
        id: `act-${now.toString(36)}`,
        label: verb[0].toUpperCase() + verb.slice(1),
        detail: `You asked: "${q.slice(0, 160)}"`,
        reversible: false,
      },
    };
  }
  const s = q.toLowerCase();
  if (/need|inbox|waiting on me|attention|decid|approv|task/.test(s)) return { text: needsAnswer(view) + tail };
  if (/block|stuck|wait/.test(s)) return { text: blockedAnswer(view) + tail };
  if (/recent|latest|update|happen|new/.test(s)) return { text: recentAnswer(view) + tail };
  if (/work|job|plan|progress|done|status/.test(s)) return { text: workAnswer(view) + tail };
  return {
    text: 'I answer from this space\'s memory, read only. Try "What needs me?", "What is blocked?", "What happened recently?" or "How is the work going?"',
  };
}

/** Split an answer into the NDJSON chunks the chat panel reads. */
export function toChunks(reply) {
  const out = [];
  for (const w of String(reply.text).split(/(\s+)/)) if (w) out.push({ t: "token", v: w });
  if (reply.action) out.push({ t: "action", ...reply.action });
  out.push({ t: "done" });
  return out;
}
