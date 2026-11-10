// clerk-user-remap.mjs — plan the move of LogMem accounts from one Clerk user id to another.
//
// Why: LogMem keys every account, workspace membership and admin role by the
// Clerk user id. A Clerk development instance and a Clerk production instance
// give the same person two different ids. After a key swap, each person signs
// in with a new id and finds no account.
//
// This script is a DRY RUN. It reads, compares and prints a plan. It writes
// nothing: every read goes through the read-only guard, and --apply is refused.
// The apply step is a separate piece of work that needs an approved plan.
//
// Input: a JSON file with id pairs only. No email addresses, no secrets.
//   [{ "from": "user_<development id>", "to": "user_<production id>" }]
// Build the pairs by matching verified email addresses between the two Clerk
// instances, outside this script.
//
// Usage:
//   node scripts/clerk-user-remap.mjs --map pairs.json
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
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readOnly } from "../src/lib/read-only.mjs";

const USER_RE = /^user_[A-Za-z0-9]{10,64}$/;
const K = {
  byClerk: (u) => `lm:account:clerk:${u}`,
  owner: (t) => `lm:account:tenant:${t}`,
  member: (u) => `lm:workspace:user:${u}`,
  owned: (u) => `lm:workspace:owned:${u}`,
  record: (id) => `lm:workspace:record:${id}`,
  role: (u) => `lm:admin:role:${u}`,
  suspended: (u) => `lm:admin:suspended:${u}`,
};

export class RemapInputError extends Error {}

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
  const ops = [], conflicts = [], notes = [];

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
    const w = parse((await redis("GET", K.record(id))) || "");
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
      ops.push({
        op: "REWRITE", key: K.record(id),
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
  for (const [name, key] of [["role", K.role], ["suspended", K.suspended]]) {
    const has = (await redis("EXISTS", key(from))) === 1;
    const targetHas = (await redis("EXISTS", key(to))) === 1;
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
  };
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--apply")) {
    process.stderr.write("Apply is not built. This script only plans. Review the plan first.\n");
    process.exit(2);
  }
  const at = args.indexOf("--map");
  if (at < 0 || !args[at + 1] || args.length !== 2) {
    process.stderr.write("Usage: node scripts/clerk-user-remap.mjs --map pairs.json\n");
    process.exit(2);
  }
  try {
    const pairs = JSON.parse(readFileSync(args[at + 1], "utf8"));
    const { customerRedis } = await import("../src/http/jail.mjs");
    const plan = await planUserRemap({ redis: customerRedis(), pairs });
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    process.exit(plan.totals.conflict ? 1 : 0);
  } catch (e) {
    // Print the message only. A Redis error can carry a connection string.
    process.stderr.write(`${e instanceof RemapInputError ? e.message : "The plan could not be built: " + String(e?.name || "Error")}\n`);
    process.exit(2);
  }
}
