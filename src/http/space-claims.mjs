// src/http/space-claims.mjs — Phase 3 1-click signed Space Claim Links.
//
// Lets a workspace OWNER mint a single-use, expiring, SHA-256-verified claim link
// (`lmc_<random>`) containing a redacted Blueprint or Full+Traces space bundle
// (with optional client-safe internal filtering and optional recipient email lock).
//
// RBAC:
//   - createSpaceClaim / listSpaceClaims / revokeSpaceClaim require `transfer-space` (owner ONLY).
//   - acceptSpaceClaim requires the recipient to be an owner or admin of the target workspace
//     with available space quota, and uses an atomic SET NX lock so a claim link can NEVER be
//     redeemed twice.

import { createHash, randomBytes } from "node:crypto";
import {
  authorizeSpace,
  readWorkspace,
  membership,
  createSpace,
  planSpaces,
  recordWorkspaceAudit,
  WorkspaceError,
} from "./workspaces.mjs";
import { exportSpace } from "./space-export.mjs";
import { importSpace } from "./space-import.mjs";

export const CLAIM_TOKEN_RE = /^lmc_[A-Za-z0-9_-]{16,128}$/;
export const MAX_CLAIM_TTL_DAYS = 30;
export const DEFAULT_CLAIM_TTL_DAYS = 7;

export class SpaceClaimError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.name = "SpaceClaimError";
    this.code = code;
    this.status = status;
  }
}

function sha256(str) {
  return createHash("sha256").update(String(str), "utf8").digest("hex");
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function maskEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm || !norm.includes("@")) return null;
  const [local, domain] = norm.split("@");
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

const claimKey = (tokenHash) => `lm:claim:${tokenHash}`;
const claimLockKey = (tokenHash) => `lm:claim:lock:${tokenHash}`;
const workspaceClaimsKey = (workspaceId) => `lm:workspace:claims:${workspaceId}`;

function parseClaimToken(token) {
  if (typeof token !== "string" || !CLAIM_TOKEN_RE.test(token.trim())) {
    throw new SpaceClaimError("invalid_claim_token", 400, "Invalid claim link token");
  }
  const clean = token.trim();
  return { token: clean, tokenHash: sha256(clean) };
}

/**
 * Create a 1-time signed Claim Link for a space (owner-only via `transfer-space`).
 */
export async function createSpaceClaim(
  {
    actorId,
    workspaceId,
    spaceId,
    mode = "blueprint",
    clientSafe = true,
    recipientEmail = "",
    ttlDays = DEFAULT_CLAIM_TTL_DAYS,
  },
  { redis, now = Date.now() },
) {
  const ctx = await authorizeSpace(
    { userId: actorId, workspaceId, spaceId, action: "transfer-space" },
    { redis },
  );

  const resolvedMode = mode === "full" ? "full" : "blueprint";
  const clampedDays = Math.max(1, Math.min(MAX_CLAIM_TTL_DAYS, Math.floor(Number(ttlDays) || DEFAULT_CLAIM_TTL_DAYS)));
  const ttlMs = clampedDays * 86400 * 1000;
  const expiresAt = now + ttlMs;

  const cleanEmail = normalizeEmail(recipientEmail);
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new SpaceClaimError("invalid_email", 400, "Recipient email is not valid");
  }

  const exported = await exportSpace(redis, ctx.space.namespace, {
    dryRun: false,
    gzip: true,
    version: 2,
    mode: resolvedMode,
    redact: true,
    clientSafe: Boolean(clientSafe),
    spaceName: ctx.space.name,
    requireApproval: true,
    approved: true,
    now,
  });

  if (!exported.ok || !Buffer.isBuffer(exported.buffer)) {
    throw new SpaceClaimError("export_failed", 500, "Could not build portable bundle for claim link");
  }

  const rawToken = `lmc_${randomBytes(24).toString("base64url")}`;
  const tokenHash = sha256(rawToken);
  const claimId = `clm_${randomBytes(8).toString("hex")}`;
  const recipientEmailHash = cleanEmail ? sha256(cleanEmail) : null;
  const recipientEmailMask = cleanEmail ? maskEmail(cleanEmail) : null;

  const record = {
    id: claimId,
    tokenHash,
    sourceWorkspaceId: workspaceId,
    sourceWorkspaceName: ctx.workspace.name,
    sourceSpaceId: spaceId,
    sourceSpaceName: ctx.space.name,
    mode: resolvedMode,
    clientSafe: Boolean(clientSafe),
    checksum: exported.checksum,
    manifest: exported.manifest,
    redaction: exported.redaction,
    sizeBytes: exported.sizeBytes,
    bundleBase64: exported.buffer.toString("base64"),
    recipientEmailHash,
    recipientEmailMask,
    createdBy: `human:${actorId}`,
    createdAt: now,
    expiresAt,
    status: "pending",
  };

  await redis("SET", claimKey(tokenHash), JSON.stringify(record), "PX", String(ttlMs));

  const summary = {
    id: claimId,
    tokenHash,
    spaceId,
    spaceName: ctx.space.name,
    mode: resolvedMode,
    clientSafe: Boolean(clientSafe),
    checksum: exported.checksum,
    sizeBytes: exported.sizeBytes,
    recipientEmailMask,
    createdBy: `human:${actorId}`,
    createdAt: now,
    expiresAt,
    status: "pending",
  };
  await redis("HSET", workspaceClaimsKey(workspaceId), claimId, JSON.stringify(summary));

  await recordWorkspaceAudit(redis, workspaceId, {
    kind: "space-claim-created",
    spaceId,
    spaceName: ctx.space.name,
    claimId,
    mode: resolvedMode,
    clientSafe: Boolean(clientSafe),
    checksum: exported.checksum,
    expiresAt,
    by: `human:${actorId}`,
    at: now,
  });

  return {
    ok: true,
    id: claimId,
    token: rawToken,
    mode: resolvedMode,
    clientSafe: Boolean(clientSafe),
    checksum: exported.checksum,
    manifest: exported.manifest,
    redaction: exported.redaction,
    sizeBytes: exported.sizeBytes,
    recipientEmailMask,
    expiresAt,
  };
}

/**
 * List claim links for a space (owner-only via `transfer-space`). Never returns raw tokens.
 */
export async function listSpaceClaims({ actorId, workspaceId, spaceId }, { redis, now = Date.now() }) {
  await authorizeSpace({ userId: actorId, workspaceId, spaceId, action: "transfer-space" }, { redis });
  const raw = await redis("HGETALL", workspaceClaimsKey(workspaceId));
  const out = [];
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) {
      try {
        const item = JSON.parse(raw[i + 1]);
        if (spaceId && item.spaceId !== spaceId) continue;
        const status = item.status === "pending" && item.expiresAt <= now ? "expired" : item.status;
        const { tokenHash: _omit, ...pub } = item;
        out.push({ ...pub, status });
      } catch { /* ignore malformed row */ }
    }
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

/**
 * Revoke an active claim link immediately (owner-only via `transfer-space`).
 */
export async function revokeSpaceClaim({ actorId, workspaceId, spaceId, claimId }, { redis, now = Date.now() }) {
  await authorizeSpace({ userId: actorId, workspaceId, spaceId, action: "transfer-space" }, { redis });
  const raw = await redis("HGET", workspaceClaimsKey(workspaceId), String(claimId || ""));
  if (!raw) throw new SpaceClaimError("claim_not_found", 404, "Claim link not found");
  const item = JSON.parse(raw);
  if (item.spaceId !== spaceId) throw new SpaceClaimError("claim_not_found", 404, "Claim link not found");
  if (item.tokenHash) await redis("DEL", claimKey(item.tokenHash));
  const updated = { ...item, status: "revoked", revokedAt: now };
  await redis("HSET", workspaceClaimsKey(workspaceId), item.id, JSON.stringify(updated));
  await recordWorkspaceAudit(redis, workspaceId, {
    kind: "space-claim-revoked",
    spaceId,
    claimId: item.id,
    by: `human:${actorId}`,
    at: now,
  });
  return { ok: true, id: item.id, status: "revoked" };
}

/**
 * Inspect a claim link for the signed-in recipient (read-only preview before claiming).
 */
export async function inspectSpaceClaim({ token, verifiedEmail = "" }, { redis, now = Date.now() }) {
  const { tokenHash } = parseClaimToken(token);
  const raw = await redis("GET", claimKey(tokenHash));
  if (!raw) throw new SpaceClaimError("claim_not_found", 404, "This claim link is invalid, expired, or already used.");
  let claim;
  try {
    claim = JSON.parse(raw);
  } catch {
    throw new SpaceClaimError("claim_not_found", 404, "Claim link could not be read.");
  }
  if (claim.status !== "pending") {
    throw new SpaceClaimError("claim_already_used", 409, "This claim link has already been used.");
  }
  if (claim.expiresAt <= now) {
    throw new SpaceClaimError("claim_expired", 410, "This claim link has expired.");
  }
  if (claim.recipientEmailHash && verifiedEmail) {
    if (sha256(normalizeEmail(verifiedEmail)) !== claim.recipientEmailHash) {
      throw new SpaceClaimError("email_mismatch", 403, "This claim link is locked to a different email address.");
    }
  }
  return {
    ok: true,
    id: claim.id,
    sourceWorkspaceName: claim.sourceWorkspaceName,
    sourceSpaceName: claim.sourceSpaceName,
    mode: claim.mode,
    clientSafe: Boolean(claim.clientSafe),
    checksum: claim.checksum,
    manifest: claim.manifest,
    redaction: claim.redaction,
    sizeBytes: claim.sizeBytes,
    expiresAt: claim.expiresAt,
    emailLocked: Boolean(claim.recipientEmailHash),
    recipientEmailMask: claim.recipientEmailMask || null,
  };
}

/**
 * Accept a 1-time claim link, creating a new space in the recipient's workspace
 * and importing the verified bundle into its fresh s-<24hex> namespace.
 * @param {any} input
 * @param {{ redis: any, now?: number, limits?: any }} deps
 */
export async function acceptSpaceClaim(
  { userId, verifiedEmail = "", targetWorkspaceId, spaceName, token, requestId },
  { redis, now = Date.now(), limits = undefined },
) {
  const { tokenHash } = parseClaimToken(token);
  const raw = await redis("GET", claimKey(tokenHash));
  if (!raw) throw new SpaceClaimError("claim_not_found", 404, "This claim link is invalid, expired, or already used.");
  const claim = JSON.parse(raw);
  if (claim.status !== "pending") throw new SpaceClaimError("claim_already_used", 409, "This claim link has already been used.");
  if (claim.expiresAt <= now) throw new SpaceClaimError("claim_expired", 410, "This claim link has expired.");
  if (claim.recipientEmailHash) {
    if (!verifiedEmail || sha256(normalizeEmail(verifiedEmail)) !== claim.recipientEmailHash) {
      throw new SpaceClaimError("email_mismatch", 403, "This claim link is locked to a different email address.");
    }
  }

  // Verify target workspace membership & space quota
  const { w } = await readWorkspace(redis, targetWorkspaceId);
  const m = membership(w, userId);
  if (!["owner", "admin"].includes(m.role)) {
    throw new WorkspaceError("forbidden", 403);
  }
  const activeSpaces = Object.values(w.spaces || {}).filter((s) => s.status === "active").length;
  const maxSpaces = planSpaces(w, limits);
  if (activeSpaces >= maxSpaces) {
    throw new WorkspaceError("space_limit", 429);
  }

  // Atomic single-use redemption lock
  const lockTtl = Math.max(60_000, claim.expiresAt - now);
  const locked = await redis("SET", claimLockKey(tokenHash), userId, "PX", String(lockTtl), "NX");
  if (!locked) {
    throw new SpaceClaimError("claim_already_used", 409, "This claim link has already been claimed.");
  }

  try {
    const finalName = String(spaceName || claim.sourceSpaceName || "Claimed space").trim().slice(0, 80);
    const reqId = String(requestId || `clm-${claim.id}-${Date.now()}`);
    const created = await createSpace(
      { userId, workspaceId: targetWorkspaceId, name: finalName, requestId: reqId },
      { redis, limits },
    );
    const bundleBuf = Buffer.from(claim.bundleBase64, "base64");
    const applied = await importSpace(redis, created.space.namespace, bundleBuf, {
      dryRun: false,
      requireApproval: true,
      approved: true,
      recordReceipt: true,
      importedBy: `human:${userId}`,
      now,
    });

    // Consume the claim record immediately
    await redis("DEL", claimKey(tokenHash));
    const existingSumRaw = await redis("HGET", workspaceClaimsKey(claim.sourceWorkspaceId), claim.id);
    if (existingSumRaw) {
      try {
        const existingSum = JSON.parse(existingSumRaw);
        await redis(
          "HSET",
          workspaceClaimsKey(claim.sourceWorkspaceId),
          claim.id,
          JSON.stringify({ ...existingSum, status: "claimed", claimedAt: now }),
        );
      } catch { /* best-effort summary update */ }
    }

    await recordWorkspaceAudit(redis, claim.sourceWorkspaceId, {
      kind: "space-claim-accepted",
      spaceId: claim.sourceSpaceId,
      claimId: claim.id,
      by: `human:${userId}`,
      at: now,
    });
    await recordWorkspaceAudit(redis, targetWorkspaceId, {
      kind: "space-imported",
      spaceId: created.space.id,
      spaceName: created.space.name,
      sourceSpace: claim.sourceSpaceName,
      mode: claim.mode,
      checksum: applied.checksum,
      created: applied.written?.created || 0,
      overwritten: 0,
      viaClaim: claim.id,
      by: `human:${userId}`,
      at: now,
    });

    return {
      ok: true,
      spaceRecord: created.space,
      written: applied.written,
      manifest: applied.manifest,
      checksum: applied.checksum,
    };
  } catch (err) {
    // Release lock only if space creation/import failed before consumption
    await redis("DEL", claimLockKey(tokenHash));
    throw err;
  }
}
