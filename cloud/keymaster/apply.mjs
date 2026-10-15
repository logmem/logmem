// cloud/keymaster/apply.mjs — grants only from approved asks; revokes on its own. Refs only in the log.
import { parseRequest } from "./request.mjs";

const BY = { by: "agent:keymaster", via: "keymaster", byline: "keymaster (via keymaster)" };
const log = (store, now, kind, trail, summary, payload) => store.append("job", "secrets", { ts: now, kind, ...BY, trail, summary, payload });

export async function applyApproved({ store, inf, token, ask, now = Date.now() }) {
  if (ask?.verdict !== "approve") return { ok: true, applied: false };
  const p = parseRequest(ask.payload);
  if (!p.ok) return { ok: false, applied: false, error: p.error };
  const done = (await store.readLog("job", "secrets")).some((e) => e.kind === "progress" && e.payload?.ask_trail === ask.trail);
  if (done) return { ok: true, applied: false };
  const { req } = p;
  const identityId = await inf.identityIdFor({ token, identity: req.identity });
  const g = identityId ? await inf.addTemporaryGrant({ token, identityId, path: req.path, ttlSeconds: req.ttlSeconds }) : { ok: false, error: `no identity named ${req.identity}` };
  const payload = { secret_ref: req.secret_ref, agent: req.identity, scope: req.scope, ttl: req.ttlSeconds, expires_at: now + req.ttlSeconds * 1000, ask_trail: ask.trail };
  if (!g.ok) {
    await log(store, now, "problem", `grantFailed-${ask.trail}`, `Grant for ${req.identity} to ${req.secret_ref} failed. The ask stays open.`, { ...payload, error: g.error });
    return { ok: false, applied: false, error: g.error };
  }
  await log(store, now, "progress", `granted-${ask.trail}`, `Granted ${req.identity} read on ${req.secret_ref} for ${Math.round(req.ttlSeconds / 86400)} days.`, payload);
  return { ok: true, applied: true };
}

// grant is a Grant from listIdentityGrants: { identity, identityId, path, grantId, ... }.
// revokeGrant needs identityId to resolve the privilege slug, so it is passed through explicitly.
export async function revoke({ store, inf, token, grant, reason, now = Date.now() }) {
  const r = await inf.revokeGrant({ token, grantId: grant.grantId, identityId: grant.identityId });
  const payload = { secret_ref: grant.path, agent: grant.identity, reason };
  if (!r.ok) {
    await log(store, now, "problem", `revokeFailed-${grant.identity}-${now}`, `Revoke for ${grant.identity} on ${grant.path} failed.`, { ...payload, error: r.error });
    return r;
  }
  await log(store, now, "progress", `revoked-${grant.identity}-${now}`, `Revoked ${grant.identity} read on ${grant.path} (${reason}).`, payload);
  return { ok: true };
}
