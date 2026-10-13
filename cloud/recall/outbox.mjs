// outbox.mjs — the queue between canonical Redis writes and the recall index.
//
//   acmi:{tenant}:outbox        LIST of JSON {ref, kind, ts}   (RPUSH / LPOP)
//   acmi:{tenant}:outbox:dlq    LIST of JSON {ref, kind, ts, attempts, error}
//   acmi:{tenant}:outbox:retry  HASH ref -> JSON {n, next}
//
// Only refs go in. Never the entry text, never a payload: the indexer loads the
// canonical entry from Redis itself, so the outbox can't carry a secret.

import { hasSecret } from "./redact.mjs";

export const TENANT_RE = /^[a-z][a-z0-9-]{2,30}$/;
export const MAX_REF = 1024;

export const outboxKey = (tenant) => `acmi:${checkTenant(tenant)}:outbox`;
export const dlqKey = (tenant) => `acmi:${checkTenant(tenant)}:outbox:dlq`;
export const retryKey = (tenant) => `acmi:${checkTenant(tenant)}:outbox:retry`;

export class RecallError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export function checkTenant(tenant) {
  if (typeof tenant !== "string" || !TENANT_RE.test(tenant)) throw new RecallError("bad_tenant", "invalid tenant id");
  return tenant;
}

/** A ref must point into the tenant's own namespace (lm:{tenant}: or acmi:{tenant}:). */
export function refInTenant(tenant, ref) {
  return typeof ref === "string" && (ref.startsWith(`lm:${tenant}:`) || ref.startsWith(`acmi:${tenant}:`));
}

export async function enqueue(redis, tenant, { ref, kind, ts } = {}) {
  checkTenant(tenant);
  if (typeof ref !== "string" || !ref || ref.length > MAX_REF) throw new RecallError("bad_ref", "invalid ref");
  if (!refInTenant(tenant, ref)) throw new RecallError("bad_ref", "ref outside tenant namespace");
  if (hasSecret(ref)) throw new RecallError("bad_ref", "ref looks secret-bearing");
  if (kind != null && (typeof kind !== "string" || kind.length > 64)) throw new RecallError("bad_kind", "invalid kind");
  const t = ts == null ? Date.now() : Number(ts);
  if (!Number.isFinite(t)) throw new RecallError("bad_ts", "invalid ts");
  const item = { ref, kind: kind ?? null, ts: t };
  return redis("RPUSH", outboxKey(tenant), JSON.stringify(item));
}
