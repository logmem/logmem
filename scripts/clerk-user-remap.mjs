// clerk-user-remap.mjs — plan the move of LogMem accounts from one Clerk user id to another.
//
// Why: LogMem keys every account, workspace membership and admin role by the
// Clerk user id. A Clerk development instance and a Clerk production instance
// give the same person two different ids. After a key swap, each person signs
// in with a new id and finds no account.
//
// The default is a DRY RUN. It reads, compares and prints a plan with a plan
// hash. Every read goes through the read-only guard.
//
// --apply writes, and only when all of these hold:
//   - --confirm carries the hash of the plan that a person reviewed
//   - the plan built now has the same hash, so the data did not change
//   - the plan has no conflict
// Each person moves in one atomic script. The script checks every record
// again inside Redis and changes nothing if any record differs from the plan.
//
// Input: a JSON file with id pairs only. No email addresses, no secrets.
//   [{ "from": "user_<development id>", "to": "user_<production id>" }]
// Build the pairs by matching verified email addresses between the two Clerk
// instances, outside this script.
//
// Usage:
//   node scripts/clerk-user-remap.mjs --map pairs.json
//   node scripts/clerk-user-remap.mjs --map pairs.json --apply --confirm <plan hash>
//
// Records read (customer Redis):
//   lm:account:clerk:{user}     tenant id of the personal account
//   lm:account:tenant:{tenant}  owner user id
//   lm:workspace:user:{user}    set of workspace ids the person is in
//   lm:workspace:owned:{user}   set of workspace ids the person owns
//   lm:workspace:record:{id}    members, audit, key attempts, connections
//   lm:admin:role:{user}        admin role
//   lm:admin:suspended:{user}   suspension
// Not moved, by design: audit history (it keeps the id that acted),
// lm:workspace:request:{user}:* replay records, and entries inside spaces
// that name human:{user}.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readOnly } from "../src/lib/read-only.mjs";
import { registerEvalScript } from "../src/lib/lua-scripts.mjs";

const USER_RE = /^user_[A-Za-z0-9]{10,64}$/;
const K = {
  byClerk: (u) => `lm:account:clerk:${u}`,
  owner: (t) => `lm:account:tenant:${t}`,
  member: (u) => `lm:workspace:user:${u}`,
  owned: (u) => `lm:workspace:owned:${u}`,
  record: (id) => `lm:workspace:record:${id}`,
  version: (id) => `lm:workspace:version:${id}`,
  audit: (id) => `lm:workspace:audit:${id}`,
  role: (u) => `lm:admin:role:${u}`,
  suspended: (u) => `lm:admin:suspended:${u}`,
};

export class RemapInputError extends Error {}
export class RemapRefusedError extends Error {}

const sha = (v) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

/** Checks the pair list. Throws on the first problem, because a bad list must not produce a plan. */
export function validatePairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw new RemapInputError("The map must be a list with at least one pair.");
  const froms = new Set(), tos = new Set();
  for (const [n, p] of pairs.entries()) {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new RemapInputError(`Pair ${n + 1} is not an object.`);
    const extra = Object.keys(p).filter((k) => k !== "from" && k !== "to");
    if (extra.length) throw new RemapInputError(`Pair ${n + 1} has extra fields. Only "from" and "to" are allowed.`);
    if (!USER_RE.test(p.from) || !USER_RE.test(p.to)) throw new RemapInputError(`Pair ${n + 1} needs two Clerk user ids.`);
    if (p.from === p.to) throw new RemapInputError(`Pair ${n + 1} maps an id to itself.`);
    if (froms.has(p.from)) throw new RemapInputError(`Pair ${n + 1} repeats a "from" id.`);
    if (tos.has(p.to)) throw new RemapInputError(`Pair ${n + 1} repeats a "to" id.`);
    froms.add(p.from);
    tos.add(p.to);
  }
  for (const id of froms) if (tos.has(id)) throw new RemapInputError("An id is both a source and a target. Chains are not allowed.");
  return pairs.map((p) => ({ from: p.from, to: p.to }));
}

const parse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
const list = async (redis, key) => ((await redis("SMEMBERS", key)) || []).map(String).sort();

async function planPair(redis, { from, to }) {
  const ops = [], conflicts = [], notes = [], records = [];

  // 1. Personal account.
  const tenant = await redis("GET", K.byClerk(from));
  const targetTenant = await redis("GET", K.byClerk(to));
  if (targetTenant) {
    conflicts.push({ code: "target_has_account", detail: `The target id already has account ${targetTenant}. The person signed in before the move. Decide which account stays.` });
  }
  if (tenant) {
    const owner = await redis("GET", K.owner(tenant));
    if (owner !== from) conflicts.push({ code: "owner_mismatch", detail: `Account ${tenant} names another owner. Do not move it.` });
    ops.push({ op: "SET", key: K.byClerk(to), value: tenant });
    ops.push({ op: "SET", key: K.owner(tenant), value: to, was: owner ?? null });
    ops.push({ op: "DEL", key: K.byClerk(from) });
  } else {
    notes.push("The source id has no personal account.");
  }

  // 2. Workspaces.
  const memberOf = await list(redis, K.member(from));
  const ownedBy = await list(redis, K.owned(from));
  const workspaces = [];
  for (const id of [...new Set([...memberOf, ...ownedBy])].sort()) {
    const raw = (await redis("GET", K.record(id))) || "";
    const w = parse(raw);
    if (!w) {
      conflicts.push({ code: "workspace_unreadable", detail: `Workspace ${id} is in the index but its record is missing or not JSON.` });
      continue;
    }
    const m = w.members?.[from];
    if (!m) {
      notes.push(`Workspace ${id} is in the index but does not list the source id as a member. The index entry moves, the record does not change.`);
    } else if (w.members?.[to]) {
      conflicts.push({ code: "target_is_member", detail: `Workspace ${id} already lists the target id as a member. Merge by hand.` });
    }
    const auditRefs = (Array.isArray(w.audit) ? w.audit : []).filter((a) => a?.by === `human:${from}` || a?.userId === from).length;
    const issuedKeys = Object.values(w.connections || {}).filter((c) => c?.issuedBy === from).length;
    workspaces.push({
      id, status: w.status ?? null, role: m?.role ?? null, memberStatus: m?.status ?? null,
      spaces: m?.spaces ? Object.keys(m.spaces).length : 0,
      version: Number(w.version) || 0, auditRefsKept: auditRefs, agentKeysIssued: issuedKeys,
      hasKeyAttempts: Boolean(w.keyAttempts?.[from]),
    });
    if (m) {
      records.push({ id, raw, w });
      ops.push({
        op: "REWRITE", key: K.record(id), recordHash: sha(raw),
        change: [
          `members: move ${from} to ${to}`,
          ...(w.keyAttempts?.[from] ? ["keyAttempts: move the same id"] : []),
          ...(issuedKeys ? [`connections: set issuedBy on ${issuedKeys} agent ${issuedKeys === 1 ? "key" : "keys"}`] : []),
          "audit: add one member-id-remapped entry, keep history",
          `version: ${Number(w.version) || 0} to ${(Number(w.version) || 0) + 1}`,
        ],
      });
    }
    if (memberOf.includes(id)) {
      ops.push({ op: "SADD", key: K.member(to), value: id });
      ops.push({ op: "SREM", key: K.member(from), value: id });
    }
    if (ownedBy.includes(id)) {
      ops.push({ op: "SADD", key: K.owned(to), value: id });
      ops.push({ op: "SREM", key: K.owned(from), value: id });
    }
  }
  const targetMemberOf = await list(redis, K.member(to));
  if (targetMemberOf.length) notes.push(`The target id is already in ${targetMemberOf.length} ${targetMemberOf.length === 1 ? "workspace" : "workspaces"}. Those stay.`);

  // 3. Admin role and suspension. Values are moved as they are and never printed.
  const admin = { role: false, suspended: false };
  for (const [name, key] of [["role", K.role], ["suspended", K.suspended]]) {
    const has = Number(await redis("EXISTS", key(from))) === 1;
    const targetHas = Number(await redis("EXISTS", key(to))) === 1;
    admin[name] = has;
    if (has && targetHas) conflicts.push({ code: `target_has_${name}`, detail: `Both ids have an admin ${name} record.` });
    if (has) {
      ops.push({ op: "COPY", key: key(to), from: key(from) });
      ops.push({ op: "DEL", key: key(from) });
    }
  }

  const found = Boolean(tenant) || workspaces.length > 0 || ops.length > 0;
  return {
    from, to,
    status: conflicts.length ? "conflict" : found ? "would-move" : "nothing-to-move",
    account: tenant ? { tenant } : null,
    workspaces, ops, conflicts, notes,
    // Not printed: a symbol key, so JSON output never carries record bodies.
    ...hidden({ tenant: tenant || "", memberOf, ownedBy, records, admin }),
  };
}

const INTERNAL = Symbol("remap-internal");
const hidden = (value) => ({ [INTERNAL]: value });

/** Hash of what a plan will change. A person reviews the plan, then passes this to --apply. */
export function planHash(results) {
  return sha(results.map((r) => ({ from: r.from, to: r.to, status: r.status, ops: r.ops, conflicts: r.conflicts })));
}

/** Builds the plan. Reads only. The same pairs on the same data give the same plan. */
export async function planUserRemap({ redis, pairs }) {
  const checked = validatePairs(pairs);
  const read = readOnly(redis, { retries: 0 });
  const results = [];
  for (const pair of checked) results.push(await planPair(read, pair));
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    applied: false,
    planHash: planHash(results),
    totals: {
      pairs: results.length,
      wouldMove: count("would-move"),
      conflict: count("conflict"),
      nothingToMove: count("nothing-to-move"),
      ops: results.reduce((n, r) => n + r.ops.length, 0),
      workspaces: new Set(results.flatMap((r) => r.workspaces.map((w) => w.id))).size,
    },
    notMoved: [
      "Workspace audit history keeps the old id.",
      "lm:workspace:request:{user}:* replay records stay with the old id.",
      "Entries inside spaces that name human:{user} do not change. An open ask addressed to the old id needs a new ask.",
    ],
    results,
  };
}

// One person, one atomic move. Every check runs again inside Redis.
// KEYS: 1 clerkFrom 2 clerkTo 3 ownerOfTenant 4 memberFrom 5 memberTo 6 ownedFrom 7 ownedTo
//       8 roleFrom 9 roleTo 10 suspFrom 11 suspTo, then per workspace: record, version, audit
// ARGV: 1 from 2 to 3 tenant 4 memberIds(json) 5 ownedIds(json) 6 moveRole 7 moveSuspended
//       8 workspaceCount, then per workspace: expectedRaw, nextRaw, nextVersion, auditEvent
const MOVE = `
local from, to, tenant = ARGV[1], ARGV[2], ARGV[3]
if redis.call('EXISTS', KEYS[2]) == 1 then return {'changed','target_has_account'} end
local mapped = redis.call('GET', KEYS[1])
if tenant == '' then
 if mapped then return {'changed','account_appeared'} end
else
 if mapped ~= tenant then return {'changed','account_changed'} end
 if redis.call('GET', KEYS[3]) ~= from then return {'changed','owner_changed'} end
end
local function same(key, json)
 local want = cjson.decode(json)
 local have = redis.call('SMEMBERS', key)
 if #have ~= #want then return false end
 local seen = {}
 for _, v in ipairs(have) do seen[v] = true end
 for _, v in ipairs(want) do if not seen[v] then return false end end
 return true
end
if not same(KEYS[4], ARGV[4]) or not same(KEYS[6], ARGV[5]) then return {'changed','membership_changed'} end
if (redis.call('EXISTS', KEYS[8]) == 1) ~= (ARGV[6] == '1') then return {'changed','role_changed'} end
if (redis.call('EXISTS', KEYS[10]) == 1) ~= (ARGV[7] == '1') then return {'changed','suspension_changed'} end
if ARGV[6] == '1' and redis.call('EXISTS', KEYS[9]) == 1 then return {'changed','target_has_role'} end
if ARGV[7] == '1' and redis.call('EXISTS', KEYS[11]) == 1 then return {'changed','target_has_suspended'} end
local n = tonumber(ARGV[8])
for i = 1, n do
 if redis.call('GET', KEYS[11 + (i-1)*3 + 1]) ~= ARGV[8 + (i-1)*4 + 1] then return {'changed','workspace_changed'} end
end
if tenant ~= '' then
 redis.call('SET', KEYS[2], tenant)
 redis.call('SET', KEYS[3], to)
 redis.call('DEL', KEYS[1])
end
for i = 1, n do
 local k, a = 11 + (i-1)*3, 8 + (i-1)*4
 redis.call('SET', KEYS[k+1], ARGV[a+2])
 redis.call('SET', KEYS[k+2], ARGV[a+3])
 redis.call('RPUSH', KEYS[k+3], ARGV[a+4])
end
for _, id in ipairs(cjson.decode(ARGV[4])) do redis.call('SADD', KEYS[5], id); redis.call('SREM', KEYS[4], id) end
for _, id in ipairs(cjson.decode(ARGV[5])) do redis.call('SADD', KEYS[7], id); redis.call('SREM', KEYS[6], id) end
if ARGV[6] == '1' then redis.call('SET', KEYS[9], redis.call('GET', KEYS[8])); redis.call('DEL', KEYS[8]) end
if ARGV[7] == '1' then redis.call('SET', KEYS[11], redis.call('GET', KEYS[10])); redis.call('DEL', KEYS[10]) end
return {'ok',''}
`;
registerEvalScript(MOVE, (call, keys, a) => {
  const [from, to, tenant] = a;
  const has = (k) => Number(call("EXISTS", k)) === 1;
  if (has(keys[1])) return ["changed", "target_has_account"];
  const mapped = call("GET", keys[0]);
  if (tenant === "") {
    if (mapped) return ["changed", "account_appeared"];
  } else {
    if (mapped !== tenant) return ["changed", "account_changed"];
    if (call("GET", keys[2]) !== from) return ["changed", "owner_changed"];
  }
  const same = (key, json) => {
    const want = JSON.parse(json), have = (call("SMEMBERS", key) || []).map(String);
    return have.length === want.length && want.every((v) => have.includes(v));
  };
  if (!same(keys[3], a[3]) || !same(keys[5], a[4])) return ["changed", "membership_changed"];
  if (has(keys[7]) !== (a[5] === "1")) return ["changed", "role_changed"];
  if (has(keys[9]) !== (a[6] === "1")) return ["changed", "suspension_changed"];
  if (a[5] === "1" && has(keys[8])) return ["changed", "target_has_role"];
  if (a[6] === "1" && has(keys[10])) return ["changed", "target_has_suspended"];
  const n = Number(a[7]);
  for (let i = 0; i < n; i++) if (call("GET", keys[11 + i * 3]) !== a[8 + i * 4]) return ["changed", "workspace_changed"];
  if (tenant !== "") {
    call("SET", keys[1], tenant);
    call("SET", keys[2], to);
    call("DEL", keys[0]);
  }
  for (let i = 0; i < n; i++) {
    call("SET", keys[11 + i * 3], a[9 + i * 4]);
    call("SET", keys[12 + i * 3], a[10 + i * 4]);
    call("RPUSH", keys[13 + i * 3], a[11 + i * 4]);
  }
  for (const id of JSON.parse(a[3])) { call("SADD", keys[4], id); call("SREM", keys[3], id); }
  for (const id of JSON.parse(a[4])) { call("SADD", keys[6], id); call("SREM", keys[5], id); }
  if (a[5] === "1") { call("SET", keys[8], call("GET", keys[7])); call("DEL", keys[7]); }
  if (a[6] === "1") { call("SET", keys[10], call("GET", keys[9])); call("DEL", keys[9]); }
  return ["ok", ""];
});

/** The workspace record after the move. History stays: one new audit entry names both ids. */
function movedRecord(w, from, to, at) {
  const next = structuredClone(w);
  const members = {};
  for (const [id, m] of Object.entries(next.members || {})) members[id === from ? to : id] = m; // keeps member order
  next.members = members;
  if (next.keyAttempts?.[from]) {
    next.keyAttempts = { ...next.keyAttempts, [to]: next.keyAttempts[from] };
    delete next.keyAttempts[from];
  }
  for (const c of Object.values(next.connections || {})) if (c?.issuedBy === from) c.issuedBy = to;
  const event = { kind: "member-id-remapped", from: `human:${from}`, to: `human:${to}`, by: "system:clerk-user-remap", at };
  next.audit = [...(Array.isArray(next.audit) ? next.audit : []), event].slice(-100);
  next.version = (Number(next.version) || 0) + 1;
  return { next, event };
}

/**
 * Applies a reviewed plan. Refuses unless `confirm` equals the hash of the plan built now
 * and that plan has no conflict. Each pair is one atomic script. A pair whose records
 * changed after the plan was read is reported as "changed" and nothing of it is written.
 */
export async function applyUserRemap({ redis, pairs, confirm, now = Date.now }) {
  const plan = await planUserRemap({ redis, pairs });
  if (!confirm || typeof confirm !== "string") throw new RemapRefusedError("Apply needs --confirm with the hash of the plan you reviewed.");
  if (plan.totals.conflict) throw new RemapRefusedError("The plan has a conflict. Nothing was written. Resolve it and run the dry run again.");
  if (confirm !== plan.planHash) throw new RemapRefusedError("The data changed after the plan you reviewed. Nothing was written. Run the dry run again.");
  const results = [];
  for (const r of plan.results) {
    if (r.status !== "would-move") {
      results.push({ from: r.from, to: r.to, status: r.status });
      continue;
    }
    const x = r[INTERNAL], at = now();
    const keys = [
      K.byClerk(r.from), K.byClerk(r.to), K.owner(x.tenant || "none"), K.member(r.from), K.member(r.to),
      K.owned(r.from), K.owned(r.to), K.role(r.from), K.role(r.to), K.suspended(r.from), K.suspended(r.to),
    ];
    const args = [r.from, r.to, x.tenant, JSON.stringify(x.memberOf), JSON.stringify(x.ownedBy), x.admin.role ? "1" : "0", x.admin.suspended ? "1" : "0", String(x.records.length)];
    for (const rec of x.records) {
      const { next, event } = movedRecord(rec.w, r.from, r.to, at);
      keys.push(K.record(rec.id), K.version(rec.id), K.audit(rec.id));
      args.push(rec.raw, JSON.stringify(next), String(next.version), JSON.stringify(event));
    }
    const [status, reason] = await redis("EVAL", MOVE, keys.length, ...keys, ...args);
    results.push(status === "ok" ? { from: r.from, to: r.to, status: "moved", workspaces: x.records.length } : { from: r.from, to: r.to, status: "changed", reason: String(reason) });
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  return { applied: true, planHash: plan.planHash, totals: { pairs: results.length, moved: count("moved"), changed: count("changed"), nothingToMove: count("nothing-to-move") }, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const known = new Set(["--map", "--apply", "--confirm"]);
  const flags = args.filter((a) => a.startsWith("--"));
  const apply = args.includes("--apply");
  const usage = "Usage: node scripts/clerk-user-remap.mjs --map pairs.json [--apply --confirm <plan hash>]\n";
  if (!value("--map") || flags.some((f) => !known.has(f)) || (args.includes("--confirm") && !apply)) {
    process.stderr.write(usage);
    process.exit(2);
  }
  if (apply && !/^[0-9a-f]{64}$/.test(value("--confirm") || "")) {
    process.stderr.write("Apply needs --confirm with the 64 character plan hash from the dry run you reviewed.\n");
    process.exit(2);
  }
  try {
    const pairs = JSON.parse(readFileSync(value("--map"), "utf8"));
    const { customerRedis } = await import("../src/http/jail.mjs");
    const redis = customerRedis();
    const out = apply ? await applyUserRemap({ redis, pairs, confirm: value("--confirm") }) : await planUserRemap({ redis, pairs });
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exit(apply ? (out.totals.changed ? 1 : 0) : out.totals.conflict ? 1 : 0);
  } catch (e) {
    // Print the message only. A Redis error can carry a connection string.
    const ours = e instanceof RemapInputError || e instanceof RemapRefusedError;
    process.stderr.write(`${ours ? e.message : "The run failed: " + String(e?.name || "Error")}\n`);
    process.exit(2);
  }
}
