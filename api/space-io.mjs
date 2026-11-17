// api/space-io.mjs — Space export and import for the signed-in operator (Phase 6.2 slice 3).
//
//   POST /api/space-io
//     intent: X-LogMem-Intent: space-io + same origin (requireIntent)
//     { action: "export-space", workspaceId, spaceId, dryRun?, gzip?, approved? }
//     { action: "import-plan",  workspaceId, spaceId, bundle, overwrite? }
//     { action: "import-apply", workspaceId, spaceId, bundle, approved?, overwrite? }
//
// Gates, in order: signed-in customer, intent + origin, owner/admin membership
// (the same bar as rename), then the library gates:
//   - export defaults to a dry run (counts only). A real payload needs
//     dryRun:false AND approved:true; the library throws approval_required.
//   - import-plan writes nothing and returns the plan with conflicts listed.
//   - import-apply passes requireApproval:true, so approved:true is required,
//     and existing keys refuse the apply unless overwrite is explicit.
// Approval discipline: approved:true is only ever sent after a LogMem ask on
// this job returns approve, with the reviewed plan/checksum in the question.
//
// Bundles exceed jsonBody's16KB cap, so the body is read raw with a4MB limit.
import { customerIdentity, requireIntent } from "../src/http/customer-http.mjs";
import { readWorkspace, membership } from "../src/http/workspaces.mjs";
import { exportSpace } from "../src/http/space-export.mjs";
import { importSpace } from "../src/http/space-import.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

const MAX_BODY = 4 * 1024 * 1024;
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

async function spaceNamespace({ userId, workspaceId, spaceId }, deps) {
  const { w } = await readWorkspace(deps.redis, workspaceId);
  if (!w) throw err("workspace_not_found", 404);
  const role = membership(w, userId).role;
  if (!["owner", "admin"].includes(role)) throw err("forbidden", 403);
  const s = w.spaces?.[spaceId];
  if (!s) throw err("not_found", 404);
  return s.namespace;
}

export function createHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
      requireIntent(req, "space-io");
      const { session, redis } = await customerIdentity(req, deps);
      const b = await readBody(req);
      if (!b.workspaceId || !b.spaceId) throw err("invalid_request", 400);
      const ns = await spaceNamespace({ userId: session?.userId, workspaceId: b.workspaceId, spaceId: b.spaceId }, { ...deps, redis });

      let out;
      if (b.action === "export-space") {
        const dryRun = b.dryRun !== false; // default: dry run
        out = await exportSpace(redis, ns, {
          dryRun,
          gzip: b.gzip === true,
          requireApproval: !dryRun,
          approved: b.approved === true,
        });
      } else if (b.action === "import-plan") {
        out = await importSpace(redis, ns, b.bundle, {
          dryRun: true,
          requireApproval: true,
          approved: false,
          overwrite: b.overwrite === true,
        });
      } else if (b.action === "import-apply") {
        out = await importSpace(redis, ns, b.bundle, {
          dryRun: false,
          requireApproval: true,
          approved: b.approved === true,
          overwrite: b.overwrite === true,
        });
      } else {
        throw err("invalid_action", 400);
      }
      return res.status(200).json(out);
    } catch (e) {
      if (Number.isInteger(e?.status) && typeof e?.code === "string") return res.status(e.status).json({ error: e.code });
      if (e?.name === "SpaceExportError" || e?.name === "SpaceImportError") {
        return res.status(e.code === "approval_required" ? 403 : 400).json({ error: e.code });
      }
      return res.status(500).json({ error: "internal_error" });
    }
  };
}

export default createHandler();
