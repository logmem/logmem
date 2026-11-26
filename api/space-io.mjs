// api/space-io.mjs — Space export and import for signed-in workspace managers (v1 + v2).
//
//   POST /api/space-io
//     intent: X-LogMem-Intent: space-io + same origin (requireIntent)
//     { action: "export-space", workspaceId, spaceId, dryRun?, gzip?, version?, mode?, redact?, approved? }
//     { action: "import-plan",  workspaceId, spaceId?, bundle, bundleEncoding?, overwrite?, skipConflicts? }
//     { action: "import-apply", workspaceId, spaceId, bundle, bundleEncoding?, approved?, overwrite?, skipConflicts?, recordReceipt? }
//     { action: "import-create-space", workspaceId, name, requestId, bundle, bundleEncoding?, approved?, recordReceipt? }
//     { action: "audit-history", workspaceId, spaceId }
//
// Gates, in order: signed-in customer, intent + origin, explicit RBAC via authorizeSpace()
// (`export-space` / `import-space` -> owner/admin only), then the library checksum/approval gates.

import { customerIdentity, requireIntent } from "../src/http/customer-http.mjs";
import { adminIdentity } from "../src/http/admin-auth.mjs";
import { descriptorFromEnv, fromDescriptor } from "../src/lib/backend.mjs";
import {
  readWorkspace,
  membership,
  authorizeSpace,
  createSpace,
  recordWorkspaceAudit,
  listWorkspaceAudit,
  planSpaces,
  WorkspaceError,
} from "../src/http/workspaces.mjs";
import { exportSpace, validateSpaceName } from "../src/http/space-export.mjs";
import { importSpace, parseBundle } from "../src/http/space-import.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };

const MAX_BODY = 16 * 1024 * 1024;
const err = (code, status) => Object.assign(new Error(code), { code, status });

async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += buf.length;
    if (size > MAX_BODY) throw err("request_too_large", 413);
    chunks.push(buf);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw err("invalid_json", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw err("invalid_json", 400);
  return parsed;
}

function decodeBundleInput(bundle, encoding) {
  if (encoding === "gzip-base64" || encoding === "base64") {
    if (typeof bundle !== "string" || !bundle.trim()) throw err("invalid_bundle", 400);
    return Buffer.from(bundle, "base64");
  }
  return bundle;
}

async function authorizeManagerSpace({ userId, workspaceId, spaceId, action }, deps) {
  const ctx = await authorizeSpace({ userId, workspaceId, spaceId, action }, deps);
  return ctx;
}

async function authorizeWorkspaceImport({ userId, workspaceId }, deps) {
  const { w } = await readWorkspace(deps.redis, workspaceId);
  const m = membership(w, userId);
  if (!["owner", "admin"].includes(m.role)) throw new WorkspaceError("forbidden", 403);
  const activeSpaces = Object.values(w.spaces || {}).filter((s) => s.status === "active").length;
  const maxSpaces = planSpaces(w, deps.limits);
  return { workspace: w, role: m.role, activeSpaces, maxSpaces, hasQuota: activeSpaces < maxSpaces };
}

export function createHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
      requireIntent(req, "space-io");
      const b = await readBody(req);
      const env = deps.env || process.env;

      // Operator-mode path (self-hosted / dev --seed with admin cookie, no Clerk workspaceId)
      if (!b.workspaceId && b.space && !deps.session) {
        const actorId = adminIdentity(req, env);
        if (!actorId) return res.status(401).json({ error: "sign_in_required" });
        const allowedSpaces = String(env.LOGMEM_VIEW_SPACES || "").split(",").map((s) => s.trim()).filter(Boolean);
        const targetSpace = String(b.space);
        validateSpaceName(targetSpace);
        if (b.action !== "import-create-space" && allowedSpaces.length > 0 && !allowedSpaces.includes(targetSpace)) {
          throw err("not_found", 404);
        }
        const desc = descriptorFromEnv(env);
        if (!desc) throw err("backend_unavailable", 503);
        const opRedis = deps.redis || fromDescriptor(desc).redis;
        if (b.action === "audit-history") {
          return res.status(200).json({ ok: true, history: [] });
        }
        if (b.action === "export-space") {
          const dryRun = b.dryRun !== false;
          const useV2 = b.version === 2 || Boolean(b.mode);
          const resExport = await exportSpace(opRedis, targetSpace, {
            dryRun,
            gzip: b.gzip === true,
            version: useV2 ? 2 : 1,
            mode: b.mode,
            redact: b.redact !== false,
            clientSafe: b.clientSafe === true,
            spaceName: targetSpace,
            requireApproval: !dryRun,
            approved: b.approved === true,
          });
          if (resExport.compressed && Buffer.isBuffer(resExport.buffer)) {
            const { buffer, ...rest } = resExport;
            return res.status(200).json({ ...rest, bufferBase64: buffer.toString("base64") });
          }
          return res.status(200).json(resExport);
        }
        if (b.action === "import-plan") {
          const input = decodeBundleInput(b.bundle, b.bundleEncoding);
          const plan = await importSpace(opRedis, targetSpace, input, {
            dryRun: true,
            requireApproval: true,
            approved: false,
            overwrite: b.overwrite === true,
            skipConflicts: b.skipConflicts === true,
          });
          return res.status(200).json(plan);
        }
        if (b.action === "import-apply" || b.action === "import-create-space") {
          const input = decodeBundleInput(b.bundle, b.bundleEncoding);
          const applied = await importSpace(opRedis, targetSpace, input, {
            dryRun: false,
            requireApproval: true,
            approved: b.approved === true,
            overwrite: b.overwrite === true,
            skipConflicts: b.skipConflicts === true,
            recordReceipt: b.recordReceipt !== false,
            importedBy: `human:${actorId}`,
          });
          return res.status(200).json(applied);
        }
        throw err("invalid_action", 400);
      }

      const { session, redis } = await customerIdentity(req, deps);
      if (!b.workspaceId) throw err("invalid_request", 400);
      const userId = session?.userId;
      const d = { ...deps, redis };

      let out;
      if (b.action === "audit-history") {
        if (!b.spaceId) throw err("invalid_request", 400);
        await authorizeManagerSpace({ userId, workspaceId: b.workspaceId, spaceId: b.spaceId, action: "export-space" }, d);
        const history = await listWorkspaceAudit(redis, b.workspaceId, {
          kinds: ["space-exported", "space-imported"],
          spaceId: b.spaceId,
          limit: 20,
        });
        return res.status(200).json({ ok: true, history });
      }

      if (b.action === "export-space") {
        if (!b.spaceId) throw err("invalid_request", 400);
        const ctx = await authorizeManagerSpace({ userId, workspaceId: b.workspaceId, spaceId: b.spaceId, action: "export-space" }, d);
        const dryRun = b.dryRun !== false; // default: dry run
        const useV2 = b.version === 2 || Boolean(b.mode) || b.clientSafe === true;
        const resExport = await exportSpace(redis, ctx.space.namespace, {
          dryRun,
          gzip: b.gzip === true,
          version: useV2 ? 2 : 1,
          mode: b.mode,
          redact: b.redact !== false,
          clientSafe: b.clientSafe === true,
          spaceName: ctx.space.name,
          requireApproval: !dryRun,
          approved: b.approved === true,
        });
        if (!dryRun && resExport.ok) {
          await recordWorkspaceAudit(redis, b.workspaceId, {
            kind: "space-exported",
            spaceId: ctx.space.id,
            spaceName: ctx.space.name,
            mode: resExport.mode || "full",
            version: useV2 ? 2 : 1,
            checksum: resExport.checksum,
            sizeBytes: resExport.sizeBytes,
            by: `human:${userId}`,
          });
        }
        if (resExport.compressed && Buffer.isBuffer(resExport.buffer)) {
          const { buffer, ...rest } = resExport;
          out = { ...rest, bufferBase64: buffer.toString("base64") };
        } else {
          out = resExport;
        }
      } else if (b.action === "import-plan") {
        const input = decodeBundleInput(b.bundle, b.bundleEncoding);
        if (b.spaceId) {
          const ctx = await authorizeManagerSpace({ userId, workspaceId: b.workspaceId, spaceId: b.spaceId, action: "import-space" }, d);
          out = await importSpace(redis, ctx.space.namespace, input, {
            dryRun: true,
            requireApproval: true,
            approved: false,
            overwrite: b.overwrite === true,
            skipConflicts: b.skipConflicts === true,
          });
        } else {
          const wsCheck = await authorizeWorkspaceImport({ userId, workspaceId: b.workspaceId }, d);
          const bundle = parseBundle(input);
          const plan = await importSpace(redis, "s-000000000000000000000000", bundle, {
            dryRun: true,
            requireApproval: true,
            approved: false,
          });
          out = {
            ...plan,
            space: null,
            quota: { activeSpaces: wsCheck.activeSpaces, maxSpaces: wsCheck.maxSpaces, hasQuota: wsCheck.hasQuota },
          };
        }
      } else if (b.action === "import-apply") {
        if (!b.spaceId) throw err("invalid_request", 400);
        const ctx = await authorizeManagerSpace({ userId, workspaceId: b.workspaceId, spaceId: b.spaceId, action: "import-space" }, d);
        const input = decodeBundleInput(b.bundle, b.bundleEncoding);
        out = await importSpace(redis, ctx.space.namespace, input, {
          dryRun: false,
          requireApproval: true,
          approved: b.approved === true,
          overwrite: b.overwrite === true,
          skipConflicts: b.skipConflicts === true,
          recordReceipt: b.recordReceipt === true,
          importedBy: `human:${userId}`,
        });
        if (out.ok) {
          await recordWorkspaceAudit(redis, b.workspaceId, {
            kind: "space-imported",
            spaceId: ctx.space.id,
            spaceName: ctx.space.name,
            sourceSpace: out.sourceSpace,
            mode: out.mode || "full",
            checksum: out.checksum,
            created: out.written?.created || 0,
            overwritten: out.written?.overwritten || 0,
            by: `human:${userId}`,
          });
        }
      } else if (b.action === "import-create-space") {
        const wsCheck = await authorizeWorkspaceImport({ userId, workspaceId: b.workspaceId }, d);
        if (!wsCheck.hasQuota) throw new WorkspaceError("space_limit", 429);
        if (b.approved !== true) throw err("approval_required", 403);
        const input = decodeBundleInput(b.bundle, b.bundleEncoding);
        const bundle = parseBundle(input);
        if (b.checksum && b.checksum !== bundle.checksum) throw err("checksum_mismatch", 400);
        const targetName = String(b.name || bundle.spaceName || bundle.space || "Imported space").trim().slice(0, 80);
        const requestId = String(b.requestId || `imp-${bundle.checksum.slice(0, 16)}-${Date.now()}`);
        const created = await createSpace({ userId, workspaceId: b.workspaceId, name: targetName, requestId }, d);
        const applied = await importSpace(redis, created.space.namespace, bundle, {
          dryRun: false,
          requireApproval: true,
          approved: true,
          recordReceipt: b.recordReceipt !== false,
          importedBy: `human:${userId}`,
        });
        await recordWorkspaceAudit(redis, b.workspaceId, {
          kind: "space-imported",
          spaceId: created.space.id,
          spaceName: created.space.name,
          sourceSpace: applied.sourceSpace,
          mode: applied.mode || "full",
          checksum: applied.checksum,
          created: applied.written?.created || 0,
          overwritten: 0,
          by: `human:${userId}`,
        });
        out = { ...applied, spaceRecord: created.space };
      } else {
        throw err("invalid_action", 400);
      }
      return res.status(200).json(out);
    } catch (e) {
      if (e instanceof WorkspaceError) return res.status(e.status).json({ error: e.code });
      if (Number.isInteger(e?.status) && typeof e?.code === "string") return res.status(e.status).json({ error: e.code });
      if (e?.name === "SpaceExportError" || e?.name === "SpaceImportError") {
        return res.status(e.code === "approval_required" ? 403 : 400).json({ error: e.code });
      }
      return res.status(500).json({ error: "internal_error" });
    }
  };
}

export default createHandler();
