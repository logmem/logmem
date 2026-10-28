// GET /api/view?space=fieldnotes&what=overview|log|agents|agent|jobs|job|channels|decisions|recall|audit|settings[&id=…][&q=…][&where=…]
// Read-only data for the web app. Production requires the admin cookie.

import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { buildView } from "../src/http/view.mjs";
import { mayRead, viewSpaces, adminEnabled, clerkViewSpaces } from "../src/http/admin-auth.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const env = process.env;
  const q = req.query || {};
  const clerkSpaces = await clerkViewSpaces(req, env);
  let allowed;
  if (clerkSpaces !== null) {
    allowed = clerkSpaces;
  } else {
    if (!(await mayRead(req, env))) return res.status(401).json({ error: adminEnabled(env) ? "sign in required" : "admin app is off: LOGMEM_ADMIN_PASSWORD is not set" });
    allowed = viewSpaces(env);
  }
  const space = String(q.space || (allowed[0] || viewSpaces(env)[0]));
  if (!allowed.includes(space)) return res.status(403).json({ error: `space '${space}' is not shown here`, spaces: allowed });
  const d = descriptorFromEnv();
  if (!d) return res.status(503).json({ error: "storage not configured on this deployment" });
  try {
    const data = await buildView(fromDescriptor(d).redis, space, String(q.what || "overview"), { id: q.id, q: q.q, where: q.where });
    res.status(200).json({ ok: true, space, spaces: viewSpaces(), generated_at: Date.now(), ...data });
  } catch (e) {
    if (e?.code === "bad_agent_id") return res.status(400).json({ error: e.message });
    sendServerError(res, "/api/view", e);
  }
}
