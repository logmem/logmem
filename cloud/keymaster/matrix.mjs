// cloud/keymaster/matrix.mjs — the values-free access matrix on job:secrets (rollout step 2, read-only).
const DAY = 86400000, STALE_DAYS = 7;
const BY = "agent:keymaster";

export function buildMatrix(grants, now = Date.now()) {
  const rows = grants
    .map((g) => ({ agent: g.identity.replace(/^agent-/, ""), identity: g.identity, path: g.path, scope: g.scope, expires_at: g.expiresAt, days_left: g.expiresAt == null ? null : Math.floor((g.expiresAt - now) / DAY) }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.path.localeCompare(b.path));
  return { rows, stale: rows.filter((r) => r.days_left != null && r.days_left < STALE_DAYS) };
}

export async function publishMatrix(store, grants, { now = Date.now() } = {}) {
  const m = buildMatrix(grants, now);
  await store.setNow("job", "secrets", { matrix: m.rows, matrix_at: now, stale_count: m.stale.length });
  for (const r of m.stale) {
    await store.append("job", "secrets", { ts: now, kind: "alert", by: BY, via: "keymaster", byline: "keymaster (via keymaster)", trail: `staleGrant-${r.agent}-${now}`, summary: `Access for ${r.identity} to ${r.path} ends in ${r.days_left} days.`, payload: { secret_ref: r.path, agent: r.identity, expires_at: r.expires_at } });
  }
  return m;
}
