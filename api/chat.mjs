import { withCustomerDashboard } from '../src/http/customer-dashboard.mjs';
// POST /api/chat  { space, history:[{role,text}] }  ->  { provider, model?, text, action? }
// Read-only chat over one space. Customers go through the shared customer boundary
// (resolveViewer, read access). Operators need the admin cookie. Both need the
// X-LogMem-Intent: chat header from the same origin. Nothing here writes.

import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { buildView } from "../src/http/view.mjs";
import { mayRead, viewSpaces, adminEnabled } from "../src/http/admin-auth.mjs";
import { requireIntent, jsonBody } from "../src/http/customer-http.mjs";
import { WorkspaceError } from "../src/http/workspaces.mjs";
import { sendServerError } from "../src/http/log.mjs";
import { chatReply, ChatInputError } from "../src/http/chat.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!mayRead(req)) return res.status(401).json({ error: adminEnabled() ? "sign in required" : "admin app is off: LOGMEM_ADMIN_PASSWORD is not set" });
  let b;
  try { requireIntent(req, "chat"); b = jsonBody(req); }
  catch (e) { if (e instanceof WorkspaceError) return res.status(e.status).json({ error: e.code }); throw e; }
  const space = String(b.space || viewSpaces()[0]);
  if (!viewSpaces().includes(space)) return res.status(403).json({ error: `space '${space}' is not shown here` });
  const d = descriptorFromEnv();
  if (!d) return res.status(503).json({ error: "storage not configured on this deployment" });
  try {
    const person = `human:${String(process.env.LOGMEM_ADMIN_ID || "admin")}`;
    const view = await buildView(fromDescriptor(d).redis, space, "home", { person });
    res.status(200).json({ ok: true, space, ...(await chatReply(b.history, view)) });
  } catch (e) {
    if (e instanceof ChatInputError) return res.status(400).json({ error: "bad_history" });
    sendServerError(res, "/api/chat", e);
  }
}

export default withCustomerDashboard(handler);
