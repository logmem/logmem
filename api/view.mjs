// GET /api/view?space=fieldnotes&what=overview|log|agents|agent|jobs|job|channels|decisions|recall|audit|settings[&id=…][&q=…][&where=…]
// Read-only data for the web app. Production requires the admin cookie.

import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { buildView } from "../src/http/view.mjs";
import { mayRead, viewSpaces, adminEnabled } from "../src/http/admin-auth.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!mayRead(req)) return res.status(401).json({ error: adminEnabled() ? "sign in required" : "admin app is off: LOGMEM_ADMIN_PASSWORD is not set" });
  const q = req.query || {};
  const space = String(q.space || viewSpaces()[0]);
  if (!viewSpaces().includes(space)) return res.status(403).json({ error: `space '${space}' is not shown here`, spaces: viewSpaces() });
  const d = descriptorFromEnv();
  if (!d) return res.status(503).json({ error: "storage not configured on this deployment" });
  try {
    const data = await buildView(fromDescriptor(d).redis, space, String(q.what || "overview"), { id: q.id, q: q.q, where: q.where });
    res.status(200).json({ ok: true, space, spaces: viewSpaces(), generated_at: Date.now(), ...data });
  } catch (e) {
    if (e?.code === "bad_agent_id") return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
}
