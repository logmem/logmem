// plans.mjs — the plan registry. Every job belongs to one plan.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-work-taxonomy-design.md.
//   lm:{space}:plan:{id}   — { id, title, owner, desc, created_at }
//   lm:{space}:plan:list   — SET of plan ids
// Every space has a "general" plan, made on first use, for work not yet filed.

export const PLAN_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const GENERAL = "general";

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanError";
  }
}

const K = {
  rec: (space, id) => `lm:${space}:plan:${id}`,
  list: (space) => `lm:${space}:plan:list`,
};

const parse = (raw) => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export function checkPlanId(id) {
  const s = String(id ?? "");
  if (!PLAN_RE.test(s)) throw new PlanError(`plan must be a short id: lowercase letters, digits and '-', up to 48 characters (got '${s.slice(0, 60)}'). Not a path or a URL`);
  return s;
}

export async function getPlan(store, id) {
  if (!PLAN_RE.test(String(id ?? ""))) return null;
  const rec = parse(await store.redis("GET", K.rec(store.space, id)));
  return rec && rec.id === id ? rec : null;
}

export async function listPlans(store) {
  const ids = ((await store.redis("SMEMBERS", K.list(store.space))) || []).filter((x) => PLAN_RE.test(x));
  return ids.sort();
}

/** Create a plan. Refuses an id that exists. */
export async function createPlan(store, { id, title, owner, desc, now = Date.now }) {
  checkPlanId(id);
  if (!title || typeof title !== "string") throw new PlanError("a plan needs a title");
  const rec = { id, title: title.slice(0, 200), owner: owner || null, ...(desc ? { desc: String(desc).slice(0, 1000) } : {}), created_at: now() };
  const ok = await store.redis("SET", K.rec(store.space, id), JSON.stringify(rec), "NX");
  if (ok !== "OK") throw new PlanError(`plan '${id}' already exists`);
  await store.redis("SADD", K.list(store.space), id);
  return rec;
}

/** The "general" plan, made the first time anything needs it. */
export async function ensureGeneral(store, { now = Date.now } = {}) {
  const have = await getPlan(store, GENERAL);
  if (have) return have;
  const rec = { id: GENERAL, title: "General: work not yet filed in a plan", owner: null, created_at: now() };
  await store.redis("SET", K.rec(store.space, GENERAL), JSON.stringify(rec), "NX");
  await store.redis("SADD", K.list(store.space), GENERAL);
  return (await getPlan(store, GENERAL)) || rec;
}

/**
 * Resolve the plan for a new job. No plan: "general" (filed: true). A plan id
 * that is not registered is refused, with the plans that exist.
 */
export async function planForJob(store, plan, { now } = {}) {
  if (plan == null || plan === "") {
    await ensureGeneral(store, { now });
    return { plan: GENERAL, filed: true };
  }
  const id = checkPlanId(plan);
  if (id === GENERAL) {
    await ensureGeneral(store, { now });
    return { plan: id, filed: false };
  }
  if (!(await getPlan(store, id))) {
    const plans = await listPlans(store);
    throw new PlanError(`no plan '${id}' in this space. Plans: ${plans.length ? plans.join(", ") : "none yet"}. Create it with logmem_plan, or use '${GENERAL}'`);
  }
  return { plan: id, filed: false };
}
