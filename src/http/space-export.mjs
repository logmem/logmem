// src/http/space-export.mjs — Space export and backup path with dry-run support.
//
// Supports:
//   - v1 (`logmem-space-backup-v1`, default when version/mode omitted for backward compat)
//   - v2 (`logmem-space-backup-v2`): Blueprint vs Full+Traces modes, Redis SET restoration
//     (agent:list, job:list, channel:list, plan:list, blocker:open), hard credential exclusion,
//     secret redaction pass, and a semantic manifest for dry-run UI previews.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const BUNDLE_FORMAT_V1 = "logmem-space-backup-v1";
export const BUNDLE_FORMAT_V2 = "logmem-space-backup-v2";
export const VALID_MODES = new Set(["blueprint", "full"]);

export class SpaceExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpaceExportError";
    this.code = code;
  }
}

export function validateSpaceName(space) {
  if (typeof space !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(space)) {
    throw new SpaceExportError("invalid_space", `Invalid space identifier: ${space}`);
  }
}

/**
 * Keys inside lm:{space}:* that are NEVER exported in v2 bundles:
 * credentials, ephemeral sessions, billing meters, mirror queues, and prior import receipts.
 */
const V2_EXCLUDED_PATTERNS = [
  /^session:/,
  /^mirror:/,
  /^sync:/,
  /^usage:/,
  /^reconcile:/,
  /^registry:/,
  /^oauth:/,
  /^meta:import$/,
  /(?:^|:)(?:agent[-_]?keys?|tokens?|secrets?|credentials?)(?::|$)/i,
];

/**
 * Keys included in v2 `blueprint` mode (starter pack):
 * Agent Who/Follows, Plans & Milestones, Channels Who, Jobs Who/Now, and Walkthroughs/Blockers.
 */
function isBlueprintKey(sub) {
  if (sub === "agent:list" || sub === "job:list" || sub === "channel:list" || sub === "plan:list" || sub === "blocker:open") return true;
  if (/^agent:[^:]+:(?:who|follows)$/.test(sub)) return true;
  if (/^channel:[^:]+:who$/.test(sub)) return true;
  if (/^job:[^:]+:(?:who|now)$/.test(sub)) return true;
  if (/^plan:[^:]+$/.test(sub)) return true;
  if (/^blocker:[^:]+$/.test(sub)) return true;
  if (/^profile:/.test(sub)) return true;
  return false;
}

export function shouldIncludeKeyV2(sub, mode = "full", { clientSafe = false } = {}) {
  if (V2_EXCLUDED_PATTERNS.some((re) => re.test(sub))) return false;
  if (clientSafe && isInternalSubKey(sub)) return false;
  if (mode === "blueprint") return isBlueprintKey(sub);
  return true;
}

const INTERNAL_CHANNEL_RE = /^(?:internal|ops|agency|private)(?:$|[-_.:/])/i;

export function isInternalChannelId(id) {
  return typeof id === "string" && INTERNAL_CHANNEL_RE.test(id.trim());
}

export function isInternalSubKey(sub) {
  if (typeof sub !== "string") return false;
  const ch = sub.match(/^channel:([^:]+):/);
  if (ch && isInternalChannelId(ch[1])) return true;
  if (/^internal(?::|$)/i.test(sub)) return true;
  return false;
}

function hasInternalFlag(doc) {
  if (!doc) return false;
  if (typeof doc === "string") {
    const parsed = tryParseJson(doc);
    return parsed && typeof parsed === "object" ? hasInternalFlag(parsed) : false;
  }
  if (typeof doc !== "object") return false;
  const obj = doc.__type === "hash" && doc.fields ? doc.fields : doc;
  return obj.visibility === "internal" || obj.internal === true || obj.visibility === "private";
}

function filterClientSafeData(data) {
  let internalFiltered = 0;
  const internalEntities = {
    agent: new Set(),
    job: new Set(),
    channel: new Set(),
    plan: new Set(),
    blocker: new Set(),
  };

  // Pass 1: identify entities tagged visibility:'internal' or internal channels
  for (const [sub, val] of Object.entries(data.other || {})) {
    const ch = sub.match(/^channel:([^:]+):/);
    if (ch && (isInternalChannelId(ch[1]) || hasInternalFlag(val))) {
      internalEntities.channel.add(ch[1]);
    }
    const ent = sub.match(/^(agent|job):([^:]+):(who|now)$/);
    if (ent && hasInternalFlag(val)) {
      internalEntities[ent[1]].add(ent[2]);
    }
    const plan = sub.match(/^plan:([^:]+)$/);
    if (plan && plan[1] !== "list" && hasInternalFlag(val)) {
      internalEntities.plan.add(plan[1]);
    }
    const blk = sub.match(/^blocker:([^:]+)$/);
    if (blk && blk[1] !== "open" && hasInternalFlag(val)) {
      internalEntities.blocker.add(blk[1]);
    }
  }

  // Pass 2: drop internal entity keys and scrub SET index lists & log entries
  const nextOther = {};
  for (const [sub, val] of Object.entries(data.other || {})) {
    const ch = sub.match(/^channel:([^:]+):/);
    if (ch && internalEntities.channel.has(ch[1])) { internalFiltered += 1; continue; }
    const ent = sub.match(/^(agent|job):([^:]+):/);
    if (ent && internalEntities[ent[1]].has(ent[2])) { internalFiltered += 1; continue; }
    const plan = sub.match(/^plan:([^:]+)$/);
    if (plan && plan[1] !== "list" && internalEntities.plan.has(plan[1])) { internalFiltered += 1; continue; }
    const blk = sub.match(/^blocker:([^:]+)$/);
    if (blk && blk[1] !== "open" && internalEntities.blocker.has(blk[1])) { internalFiltered += 1; continue; }

    // Scrub SET indexes
    if (val?.__type === "set" && Array.isArray(val.members)) {
      if (sub === "channel:list") {
        const kept = val.members.filter((id) => !isInternalChannelId(id) && !internalEntities.channel.has(id));
        internalFiltered += val.members.length - kept.length;
        nextOther[sub] = { __type: "set", members: kept };
        continue;
      }
      if (sub === "agent:list" || sub === "job:list" || sub === "plan:list") {
        const kind = sub.split(":")[0];
        const kept = val.members.filter((id) => !internalEntities[kind].has(id));
        internalFiltered += val.members.length - kept.length;
        nextOther[sub] = { __type: "set", members: kept };
        continue;
      }
      if (sub === "blocker:open") {
        const kept = val.members.filter((id) => !internalEntities.blocker.has(id));
        internalFiltered += val.members.length - kept.length;
        nextOther[sub] = { __type: "set", members: kept };
        continue;
      }
    }

    // Scrub internal log/activity entries
    if (val?.__type === "zset" && Array.isArray(val.entries) && (/:log$/.test(sub) || sub === "activity")) {
      const kept = val.entries.filter((e) => {
        const parsed = tryParseJson(e.member);
        if (parsed && typeof parsed === "object") {
          if (parsed.visibility === "internal" || parsed.visibility === "private" || parsed.internal === true) return false;
          if (typeof parsed.where === "string" && parsed.where.startsWith("channel:")) {
            const cid = parsed.where.slice("channel:".length);
            if (isInternalChannelId(cid) || internalEntities.channel.has(cid)) return false;
          }
          if (typeof parsed.where === "string" && parsed.where.startsWith("job:")) {
            const jid = parsed.where.slice("job:".length);
            if (internalEntities.job.has(jid)) return false;
          }
        }
        return true;
      });
      internalFiltered += val.entries.length - kept.length;
      nextOther[sub] = { __type: "zset", entries: kept };
      continue;
    }

    nextOther[sub] = val;
  }

  const nextTimelines = {};
  for (const [sub, val] of Object.entries(data.timelines || {})) {
    if (Array.isArray(val)) {
      const kept = val.filter((e) => {
        const raw = typeof e === "object" && e !== null && "member" in e ? e.member : e;
        const parsed = tryParseJson(raw);
        if (parsed && typeof parsed === "object" && (parsed.visibility === "internal" || parsed.internal === true)) {
          return false;
        }
        return true;
      });
      internalFiltered += val.length - kept.length;
      nextTimelines[sub] = kept;
    } else {
      nextTimelines[sub] = val;
    }
  }

  return {
    data: { ...data, other: nextOther, timelines: nextTimelines },
    internalFiltered,
  };
}

/** Targeted secret patterns redacted in v2 exports without mangling ordinary URLs or IDs. */
const SECRET_PATTERNS = [
  /\blmk_[A-Za-z0-9_-]{12,}\b/g,
  /\blmi_[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-(?:live|test|proj|ant-api\d+)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:rediss?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^@\s"'<>]+@[^\s"'<>]+/gi,
  /\bBearer\s+[A-Za-z0-9._+/=-]{16,}\b/gi,
  /(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?)([^\s"',}\]]{8,})/gi,
];

export function redactString(input, counter = { count: 0 }) {
  if (typeof input !== "string" || !input) return input;
  let out = input;
  for (let i = 0; i < SECRET_PATTERNS.length; i++) {
    const re = SECRET_PATTERNS[i];
    re.lastIndex = 0;
    if (i === SECRET_PATTERNS.length - 1) {
      out = out.replace(re, (_m, prefix) => {
        counter.count += 1;
        return `${prefix}[redacted]`;
      });
    } else {
      out = out.replace(re, () => {
        counter.count += 1;
        return "[redacted]";
      });
    }
  }
  return out;
}

export function redactValue(value, counter = { count: 0 }) {
  if (typeof value === "string") return redactString(value, counter);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, counter));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/(?:^|_)(?:password|secret|api_?key|access_?token|refresh_?token|private_?key|agent_?key)$/i.test(k) && typeof v === "string" && v.length > 0) {
        counter.count += 1;
        out[k] = "[redacted]";
      } else {
        out[k] = redactValue(v, counter);
      }
    }
    return out;
  }
  return value;
}

async function mapConcurrent(items, limit, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Scan all Redis keys matching a pattern.
 */
export async function scanKeys(redis, pattern, batchSize = 200) {
  const matching = [];
  let cursor = "0";
  do {
    const res = await redis("SCAN", cursor, "MATCH", pattern, "COUNT", String(batchSize));
    if (!Array.isArray(res) || res.length < 2) break;
    cursor = String(res[0]);
    const keys = Array.isArray(res[1]) ? res[1] : [];
    for (const k of keys) matching.push(String(k));
  } while (cursor !== "0");
  return matching;
}

function tryParseJson(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

/** Build a human-readable semantic manifest from collected v2 data or dry-run keys. */
export function buildManifestFromData(data) {
  const agents = new Map();
  const plans = new Map();
  const jobs = new Set();
  const channels = new Set();
  let milestones = 0;
  let decisions = Object.keys(data.decisions || {}).length;
  let traces = 0;

  for (const entries of Object.values(data.timelines || {})) {
    if (Array.isArray(entries)) traces += entries.length;
  }

  for (const [sub, val] of Object.entries(data.other || {})) {
    const agentWho = sub.match(/^agent:([^:]+):who$/);
    if (agentWho) {
      const id = agentWho[1];
      const doc = val && typeof val === "object" && val.__type === "hash" ? val.fields : tryParseJson(val);
      const name = (doc && typeof doc === "object" && (doc.name || doc.title || doc.display_name)) || id;
      const role = (doc && typeof doc === "object" && (doc.role || doc.bio || doc.summary)) || "";
      agents.set(id, { id, name: String(name).slice(0, 64), role: String(role).slice(0, 100) });
    }
    if (sub === "agent:list" && val?.__type === "set" && Array.isArray(val.members)) {
      for (const id of val.members) {
        if (!agents.has(id)) agents.set(id, { id, name: id, role: "" });
      }
    }
    const planMatch = sub.match(/^plan:([^:]+)$/);
    if (planMatch && planMatch[1] !== "list") {
      const id = planMatch[1];
      const doc = val && typeof val === "object" && val.__type === "hash" ? val.fields : tryParseJson(val);
      const title = (doc && typeof doc === "object" && (doc.title || doc.name)) || id;
      plans.set(id, { id, title: String(title).slice(0, 80) });
      if (doc && typeof doc === "object" && Array.isArray(doc.milestones)) {
        milestones += doc.milestones.length;
      }
    }
    if (sub === "plan:list" && val?.__type === "set" && Array.isArray(val.members)) {
      for (const id of val.members) {
        if (!plans.has(id)) plans.set(id, { id, title: id });
      }
    }
    const jobMatch = sub.match(/^job:([^:]+):/);
    if (jobMatch) jobs.add(jobMatch[1]);
    if (sub === "job:list" && val?.__type === "set" && Array.isArray(val.members)) {
      for (const id of val.members) jobs.add(id);
    }
    const chanMatch = sub.match(/^channel:([^:]+):/);
    if (chanMatch) channels.add(chanMatch[1]);
    if (sub === "channel:list" && val?.__type === "set" && Array.isArray(val.members)) {
      for (const id of val.members) channels.add(id);
    }
    if (/:log$/.test(sub) && val?.__type === "zset" && Array.isArray(val.entries)) {
      traces += val.entries.length;
    }
    if (sub === "activity" && val?.__type === "zset" && Array.isArray(val.entries) && traces === 0) {
      traces += val.entries.length;
    }
  }

  for (const sub of Object.keys(data.profiles || {})) {
    const id = sub.replace(/^profile:/, "");
    if (id && !agents.has(id)) agents.set(id, { id, name: id, role: "" });
  }

  return {
    agents: agents.size,
    plans: plans.size,
    milestones,
    jobs: jobs.size,
    channels: channels.size,
    decisions,
    traces,
    sampleAgents: Array.from(agents.values()).slice(0, 8),
    samplePlans: Array.from(plans.values()).slice(0, 6),
  };
}

function buildDryRunManifestFromKeys(subs, categorized) {
  const agents = new Set();
  const plans = new Set();
  const jobs = new Set();
  const channels = new Set();
  let logKeys = categorized.timelines.length;

  for (const sub of subs) {
    const a = sub.match(/^agent:([^:]+):/);
    if (a && a[1] !== "list") agents.add(a[1]);
    const p = sub.match(/^plan:([^:]+)$/);
    if (p && p[1] !== "list") plans.add(p[1]);
    const j = sub.match(/^job:([^:]+):/);
    if (j && j[1] !== "list") jobs.add(j[1]);
    const c = sub.match(/^channel:([^:]+):/);
    if (c && c[1] !== "list") channels.add(c[1]);
    if (/:log$/.test(sub)) logKeys += 1;
  }

  return {
    agents: agents.size || categorized.profiles.length,
    plans: plans.size,
    milestones: 0,
    jobs: jobs.size,
    channels: channels.size,
    decisions: categorized.decisions.length,
    traces: logKeys,
    sampleAgents: Array.from(agents).slice(0, 8).map((id) => ({ id, name: id, role: "" })),
    samplePlans: Array.from(plans).slice(0, 6).map((id) => ({ id, title: id })),
  };
}

/**
 * Perform a space backup/export.
 * @param {any} redis
 * @param {string} space
 * @param {{ dryRun?: boolean, gzip?: boolean, requireApproval?: boolean, approved?: boolean, version?: number, mode?: string, redact?: boolean, clientSafe?: boolean, spaceName?: string | null, now?: number }} [opts]
 */
export async function exportSpace(redis, space, {
  dryRun = false,
  gzip = false,
  requireApproval = false,
  approved = false,
  version,
  mode,
  redact = true,
  clientSafe = false,
  spaceName,
  now = Date.now(),
} = {}) {
  validateSpaceName(space);

  const resolvedVersion = version ?? (mode || clientSafe ? 2 : 1);
  if (resolvedVersion !== 1 && resolvedVersion !== 2) {
    throw new SpaceExportError("invalid_version", `Unsupported export version: ${resolvedVersion}`);
  }
  const resolvedMode = mode || "full";
  if (!VALID_MODES.has(resolvedMode)) {
    throw new SpaceExportError("invalid_mode", `Invalid export mode: ${resolvedMode} (use blueprint or full)`);
  }

  if (requireApproval && !dryRun && !approved) {
    throw new SpaceExportError("approval_required", "Space export requires explicit operator approval flag (approved: true)");
  }

  const prefix = `lm:${space}:`;
  const scannedKeys = await scanKeys(redis, `${prefix}*`);

  let excludedKeys = 0;
  let internalKeyExcluded = 0;
  const allKeys = resolvedVersion === 2
    ? scannedKeys.filter((k) => {
        const sub = k.slice(prefix.length);
        const keep = shouldIncludeKeyV2(sub, resolvedMode, { clientSafe });
        if (!keep) {
          excludedKeys += 1;
          if (clientSafe && isInternalSubKey(sub)) internalKeyExcluded += 1;
        }
        return keep;
      })
    : scannedKeys;

  const categorized = {
    profiles: [],
    signals: [],
    timelines: [],
    decisions: [],
    other: [],
  };

  for (const k of allKeys) {
    const sub = k.slice(prefix.length);
    if (sub.startsWith("profile:")) categorized.profiles.push(k);
    else if (sub.startsWith("signals:")) categorized.signals.push(k);
    else if (sub.startsWith("timeline:") || sub.startsWith("t:")) categorized.timelines.push(k);
    else if (sub.startsWith("decision:") || sub.startsWith("ask:")) categorized.decisions.push(k);
    // Who/Now hashes, Log zsets, and entity SET indexes (lm:{space}:{kind}:{id}:who|now|log|list) land in other.
    else categorized.other.push(k);
  }

  if (dryRun) {
    const subs = allKeys.map((k) => k.slice(prefix.length));
    const manifest = resolvedVersion === 2 ? buildDryRunManifestFromKeys(subs, categorized) : undefined;
    return {
      ok: true,
      space,
      ...(resolvedVersion === 2 ? { version: 2, mode: resolvedMode, clientSafe: Boolean(clientSafe), excludedKeys, internalKeyExcluded, manifest } : {}),
      dryRun: true,
      totalKeys: allKeys.length,
      counts: {
        profiles: categorized.profiles.length,
        signals: categorized.signals.length,
        timelines: categorized.timelines.length,
        decisions: categorized.decisions.length,
        other: categorized.other.length,
      },
      estimatedBytes: allKeys.length * 512,
      scanned_at: new Date(now).toISOString(),
    };
  }

  // Collect data with bounded concurrency (fast over REST & TLS, deterministic key order)
  const data = {
    profiles: {},
    signals: {},
    timelines: {},
    decisions: {},
    other: {},
  };

  const CONCURRENCY = 24;

  const profileRows = await mapConcurrent(categorized.profiles, CONCURRENCY, async (k) => {
    const type = String(await redis("TYPE", k)).toLowerCase();
    const short = k.slice(prefix.length);
    if (type === "hash") {
      const entries = await redis("HGETALL", k);
      const parsed = {};
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) parsed[entries[i]] = tryParseJson(entries[i + 1]);
      }
      return [short, parsed];
    }
    return [short, tryParseJson(await redis("GET", k))];
  });
  for (const [short, val] of profileRows) data.profiles[short] = val;

  const signalRows = await mapConcurrent(categorized.signals, CONCURRENCY, async (k) => {
    const type = String(await redis("TYPE", k)).toLowerCase();
    const short = k.slice(prefix.length);
    if (type === "hash") {
      const entries = await redis("HGETALL", k);
      const parsed = {};
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) parsed[entries[i]] = tryParseJson(entries[i + 1]);
      }
      return [short, parsed];
    }
    return [short, tryParseJson(await redis("GET", k))];
  });
  for (const [short, val] of signalRows) data.signals[short] = val;

  const timelineRows = await mapConcurrent(categorized.timelines, CONCURRENCY, async (k) => {
    const type = String(await redis("TYPE", k)).toLowerCase();
    const short = k.slice(prefix.length);
    if (type === "zset") {
      const entries = await redis("ZRANGE", k, "0", "-1", "WITHSCORES");
      const list = [];
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) list.push({ member: entries[i], score: Number(entries[i + 1]) });
      }
      return [short, list];
    }
    if (type === "list") return [short, await redis("LRANGE", k, "0", "-1")];
    return [short, await redis("GET", k)];
  });
  for (const [short, val] of timelineRows) data.timelines[short] = val;

  const decisionRows = await mapConcurrent(categorized.decisions, CONCURRENCY, async (k) => [
    k.slice(prefix.length),
    await redis("GET", k),
  ]);
  for (const [short, val] of decisionRows) data.decisions[short] = val;

  const otherRows = await mapConcurrent(categorized.other, CONCURRENCY, async (k) => {
    const type = String(await redis("TYPE", k)).toLowerCase();
    const short = k.slice(prefix.length);
    if (type === "string") return [short, await redis("GET", k)];
    if (type === "hash") {
      const entries = await redis("HGETALL", k);
      const parsed = {};
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) parsed[entries[i]] = tryParseJson(entries[i + 1]);
      }
      return [short, { __type: "hash", fields: parsed }];
    }
    if (type === "zset") {
      const entries = await redis("ZRANGE", k, "0", "-1", "WITHSCORES");
      const list = [];
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) list.push({ member: entries[i], score: Number(entries[i + 1]) });
      }
      return [short, { __type: "zset", entries: list }];
    }
    if (type === "list") return [short, { __type: "list", entries: await redis("LRANGE", k, "0", "-1") }];
    if (type === "set" && resolvedVersion === 2) {
      const members = await redis("SMEMBERS", k);
      return [short, { __type: "set", members: Array.isArray(members) ? [...members].map(String).sort() : [] }];
    }
    return [short, { __type: type || "unknown", skipped: true }];
  });
  for (const [short, val] of otherRows) data.other[short] = val;

  const filtered = resolvedVersion === 2 && clientSafe
    ? filterClientSafeData(data)
    : { data, internalFiltered: 0 };
  const redactionCounter = { count: 0 };
  const finalData = resolvedVersion === 2 && redact ? redactValue(filtered.data, redactionCounter) : filtered.data;
  const manifest = resolvedVersion === 2 ? buildManifestFromData(finalData) : undefined;

  const exportPayload = resolvedVersion === 2
    ? {
        format: BUNDLE_FORMAT_V2,
        space,
        ...(spaceName ? { spaceName: String(spaceName).slice(0, 80) } : {}),
        mode: resolvedMode,
        clientSafe: Boolean(clientSafe),
        exported_at: new Date(now).toISOString(),
        redaction: {
          keysExcluded: true,
          excludedKeyCount: excludedKeys,
          secretsRedacted: redactionCounter.count,
          clientSafe: Boolean(clientSafe),
          internalFilteredCount: internalKeyExcluded + filtered.internalFiltered,
        },
        manifest,
        counts: {
          keys: allKeys.length,
          profiles: categorized.profiles.length,
          signals: categorized.signals.length,
          timelines: categorized.timelines.length,
          decisions: categorized.decisions.length,
          other: categorized.other.length,
        },
        data: finalData,
      }
    : {
        format: BUNDLE_FORMAT_V1,
        space,
        exported_at: new Date(now).toISOString(),
        counts: {
          keys: allKeys.length,
          profiles: categorized.profiles.length,
          signals: categorized.signals.length,
          timelines: categorized.timelines.length,
          decisions: categorized.decisions.length,
          other: categorized.other.length,
        },
        data: finalData,
      };

  const checksum = createHash("sha256").update(JSON.stringify(exportPayload), "utf8").digest("hex");
  exportPayload.checksum = checksum;
  const jsonString = JSON.stringify(exportPayload, null, 2);

  if (gzip) {
    const compressed = gzipSync(Buffer.from(jsonString, "utf8"));
    return {
      ok: true,
      space,
      ...(resolvedVersion === 2 ? { version: 2, mode: resolvedMode, manifest, redaction: exportPayload.redaction } : {}),
      dryRun: false,
      checksum,
      compressed: true,
      sizeBytes: compressed.length,
      buffer: compressed,
      counts: exportPayload.counts,
    };
  }

  return {
    ok: true,
    space,
    ...(resolvedVersion === 2 ? { version: 2, mode: resolvedMode, manifest, redaction: exportPayload.redaction } : {}),
    dryRun: false,
    checksum,
    compressed: false,
    sizeBytes: Buffer.byteLength(jsonString, "utf8"),
    json: jsonString,
    counts: exportPayload.counts,
  };
}
