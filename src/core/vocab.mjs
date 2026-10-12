// vocab.mjs — the LogMem ↔ ACMI dictionary.
//
// Source of truth: the LogMem Action Map
// (https://claude.ai/artifact/UaJF3X5bn8eYbhq2ZkJoN3). Keep this file and that
// page in step; the tool contract spec (claude-engineer, due 2026-10-14) may
// still rename things, so nothing outside this file hard-codes a word.

// ─── Entry kinds ────────────────────────────────────────────────────────
// LogMem word -> { acmi: primary ACMI kind, also: ACMI aliases, group }
export const KINDS = {
  started: { acmi: "spawn", also: ["session-start"], group: "system" },
  ping: { acmi: "heartbeat", also: [], group: "system" },
  recap: { acmi: "rollup", also: ["pre-compact-snapshot"], group: "system" },
  joined: { acmi: "onboarding-complete", also: [], group: "system" },
  setup: { acmi: "install", also: [], group: "system" },
  handoff: { acmi: "handoff", also: ["task-delegation"], group: "handoff" },
  accepted: { acmi: "handoff-ack", also: [], group: "handoff" },
  assigned: { acmi: "work-created", also: [], group: "work" },
  progress: { acmi: "work-update", also: [], group: "work" },
  done: { acmi: "work-completed", also: ["milestone-shipped"], group: "work" },
  shared: { acmi: "artifact-published", also: [], group: "work" },
  research: { acmi: "research-brief", also: [], group: "work" },
  checkup: { acmi: "diagnostic-report", also: ["audit-report"], group: "work" },
  feedback: { acmi: "review-note", also: [], group: "work" },
  approval: { acmi: "decision-request", also: [], group: "decision" },
  decided: { acmi: "decision", also: ["decision-ratified"], group: "decision" },
  pivot: { acmi: "scope-decision", also: [], group: "decision" },
  stuck: { acmi: "stalled-alert", also: [], group: "signal" },
  alert: { acmi: "critical-finding", also: [], group: "signal" },
  memo: { acmi: "coord-note", also: [], group: "signal" },
  huddle: { acmi: "fleet-sync", also: [], group: "signal" },
  problem: { acmi: "incident-update", also: [], group: "error" },
  fix: { acmi: "correction", also: ["alignment-fix"], group: "error" },
};

const ACMI_TO_LM = new Map();
for (const [word, d] of Object.entries(KINDS)) {
  ACMI_TO_LM.set(d.acmi, word);
  for (const a of d.also) ACMI_TO_LM.set(a, word);
}

export const isLogmemKind = (k) => Object.hasOwn(KINDS, k);

/**
 * ACMI kind -> { kind, acmi_kind? }.
 * `acmi_kind` is kept only when the original was an alias (so compat reads
 * give back exactly what was written). Unknown kinds pass through untouched.
 */
export function kindFromAcmi(acmiKind) {
  if (acmiKind == null) return { kind: acmiKind };
  const word = ACMI_TO_LM.get(acmiKind);
  if (!word) return { kind: acmiKind };
  return KINDS[word].acmi === acmiKind ? { kind: word } : { kind: word, acmi_kind: acmiKind };
}

/** LogMem word (+ optional preserved alias) -> ACMI kind. */
export function kindToAcmi(kind, acmiKind) {
  if (acmiKind) return acmiKind;
  return isLogmemKind(kind) ? KINDS[kind].acmi : kind;
}

/** Accept either vocabulary on input; always store the LogMem word. */
export function normalizeKind(kind) {
  if (!kind) return { kind: "memo" };
  if (isLogmemKind(kind)) return { kind };
  return kindFromAcmi(kind);
}

// ─── Entry fields ───────────────────────────────────────────────────────
// ACMI field -> LogMem field. Everything else is carried as-is.
export const FIELDS = {
  correlationId: "trail",
  parentCorrelationId: "origin",
  source: "by",
  tenant_id: "space",
  speaker_type: "speaker",
};
const FIELDS_BACK = Object.fromEntries(Object.entries(FIELDS).map(([a, l]) => [l, a]));

/** ACMI TimelineEvent -> LogMem entry. Lossless; inverse is entryToAcmi. */
export function entryFromAcmi(ev) {
  if (!ev || typeof ev !== "object") return ev;
  const out = {};
  for (const [k, v] of Object.entries(ev)) {
    if (k === "kind") Object.assign(out, kindFromAcmi(v));
    else out[FIELDS[k] ?? k] = v;
  }
  return out;
}

/** LogMem entry -> ACMI TimelineEvent. */
export function entryToAcmi(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === "acmi_kind") continue;
    if (k === "kind") out.kind = kindToAcmi(v, entry.acmi_kind);
    else out[FIELDS_BACK[k] ?? k] = v;
  }
  return out;
}

/**
 * Read-path normalizer: an entry read from Redis may be in either shape
 * (legacy acmi:* data, or old hosted writes). Detect and translate forward.
 */
export function asEntry(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const acmiShaped = "source" in raw || "correlationId" in raw || "parentCorrelationId" in raw;
  return acmiShaped ? entryFromAcmi(raw) : raw;
}

// ─── Tools ──────────────────────────────────────────────────────────────
// LogMem tool -> ACMI tool it stands in for (null = new in LogMem).
export const TOOLS = {
  logmem_start: "acmi_spawn",
  logmem_brief: "acmi_bootstrap",
  logmem_recap: "acmi_rollup_set",
  logmem_note: "acmi_event",
  logmem_handoff: null,
  logmem_ask: null,
  logmem_status: "acmi_signal",
  logmem_bio: "acmi_profile",
  logmem_view: "acmi_get",
  logmem_roster: "acmi_list",
  logmem_feed: "acmi_cat",
  logmem_follow: "acmi_active",
  logmem_assign: "acmi_work_create",
  logmem_update: "acmi_work_event",
  logmem_stage: "acmi_work_signal",
  logmem_open: "acmi_work_get",
  logmem_jobs: "acmi_work_list",
  logmem_recall: "acmi_search_semantic",
  logmem_remove: "acmi_delete",
  logmem_spaces: "acmi_tenant_list",
  logmem_connection: "acmi_mcp_status",
};

// ─── Namespaces ─────────────────────────────────────────────────────────
// ACMI namespace -> LogMem namespace (Concepts tab: Channel = thread, Job = work).
export const NAMESPACES = { thread: "channel", work: "job", agent: "agent" };
const NS_BACK = Object.fromEntries(Object.entries(NAMESPACES).map(([a, l]) => [l, a]));
export const nsFromAcmi = (ns) => NAMESPACES[ns] ?? ns;
export const nsToAcmi = (ns) => NS_BACK[ns] ?? ns;
