// accounts.mjs — one managed LogMem account per Clerk user.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-one-click-connect-design.md, 4.1.
// The first sign-in of an invited person creates a tenant (plan free) with
// the space t-{id}. Later sign-ins find it through the Clerk mapping. The
// tenant id is random and never comes from the email.
//
// Records on the customer Redis (server code only, never a jailed runner):
//   lm:account:clerk:{clerkUserId}  — tenant id (claimed with SET NX)
//   lm:account:tenant:{tenantId}    — clerk user id (owner, for connected apps)
//   acmi:cloud:tenant:{id}          — the tenant, via cloud/tenants
// A person who is not invited is added to the waitlist (source "connect").

import { randomBytes } from "node:crypto";
import { createTenant, getTenant, namespaceFor, validTenantId } from "../../cloud/tenants/index.mjs";
import { isInvited } from "./invites.mjs";
import { normalizeEmail } from "../../api/onboarding/waitlist.mjs";
import { saveSignup } from "./waitlist-store.mjs";

const CLERK_ID_RE = /^user_[A-Za-z0-9]{10,64}$/;
const K = { byClerk: (u) => `lm:account:clerk:${u}`, owner: (t) => `lm:account:tenant:${t}` };
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export class AccountError extends Error {
  constructor(message) {
    super(message);
    this.name = "AccountError";
  }
}

/** "u" plus 10 random lowercase letters and digits. */
export function newTenantId() {
  const bytes = randomBytes(10);
  let s = "u";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

function shape(t) {
  return { tenant: t.id, space: namespaceFor(t.id), plan: t.plan, status: t.status };
}

/** The tenant behind a claimed id, created if a racing first sign-in has not finished it yet. */
async function ensureTenant(redis, id) {
  const existing = await getTenant(redis, id);
  if (existing) return existing;
  try {
    return await createTenant(redis, { id, name: "Personal", plan: "free" });
  } catch {
    const t = await getTenant(redis, id);
    if (t) return t;
    throw new AccountError("account could not be created");
  }
}

/**
 * Resolve the managed account for a signed-in Clerk user.
 * Returns { tenant, space, plan, status, created } or { waitlist: true }.
 * deps: { redis (customer Redis, unjailed), waitlistRedis, env, newId }.
 */
export async function accountFor({ clerkUserId, email } = {}, { redis, waitlistRedis = null, env = process.env, newId = newTenantId } = {}) {
  if (!CLERK_ID_RE.test(String(clerkUserId || ""))) throw new AccountError("clerk user id is not valid");
  const key = K.byClerk(clerkUserId);

  const mapped = await redis("GET", key);
  if (mapped) {
    if (!validTenantId(mapped)) throw new AccountError("account record is not valid");
    return { ...shape(await ensureTenant(redis, mapped)), created: false };
  }

  if (!(await isInvited(email, { redis, env }))) {
    const e = normalizeEmail(email);
    if (e && waitlistRedis) await saveSignup(waitlistRedis, { email: e, attribution: { utm_source: "connect" } });
    return { waitlist: true };
  }

  const id = newId();
  if (!validTenantId(id)) throw new AccountError("generated tenant id is not valid");
  const claimed = (await redis("SET", key, id, "NX")) === "OK";
  const tenantId = claimed ? id : await redis("GET", key);
  if (!validTenantId(tenantId)) throw new AccountError("account record is not valid");
  const t = await ensureTenant(redis, tenantId);
  if (claimed) await redis("SET", K.owner(tenantId), clerkUserId);
  return { ...shape(t), created: claimed };
}

/** The Clerk user who owns a tenant, or null. */
export async function ownerOf(tenantId, { redis } = {}) {
  if (!validTenantId(tenantId)) return null;
  return (await redis("GET", K.owner(tenantId))) || null;
}
