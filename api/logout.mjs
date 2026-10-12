// POST /api/logout -> clears the admin cookie.
import { clearCookie } from "../src/http/admin-auth.mjs";

export const config = { runtime: "nodejs" };

export default function handler(req, res) {
  res.setHeader("Set-Cookie", clearCookie());
  res.status(200).json({ ok: true });
}
