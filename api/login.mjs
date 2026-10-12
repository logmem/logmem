// POST /api/login {password} -> admin cookie. GET -> {signedIn, enabled}.
import { checkPassword, issueCookie, isAdmin, adminEnabled } from "../src/http/admin-auth.mjs";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ enabled: adminEnabled(), signedIn: isAdmin(req), production: process.env.VERCEL_ENV === "production" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!adminEnabled()) return res.status(503).json({ error: "admin app is off: LOGMEM_ADMIN_PASSWORD is not set" });
  const password = (req.body && req.body.password) || "";
  if (!checkPassword(password)) {
    await new Promise((ok) => setTimeout(ok, 800));
    return res.status(401).json({ error: "That password isn't right." });
  }
  res.setHeader("Set-Cookie", issueCookie());
  return res.status(200).json({ ok: true });
}
