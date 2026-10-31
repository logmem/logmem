// POST /api/login -> admin cookie. GET -> {signedIn, enabled}.
//
// Two ways in, both account-bound where possible (slice 2):
//   {password}                    -> legacy cookie, attribution "break-glass".
//                                     Kept for the operator and for break-glass
//                                     when Clerk itself is unreachable.
//   {} with a valid Clerk session  -> identity cookie carrying the user id,
//                                     but only when that account holds an
//                                     admin or support role (admin-roles.mjs).
// The password path stays exactly as it was: an 800ms delay on failure.
import { checkPassword, issueCookie, issueIdentityCookie, isAdmin, adminEnabled } from "../src/http/admin-auth.mjs";
import { customerSession } from "../src/http/clerk.mjs";
import { getRole, ROLES } from "../src/http/admin-roles.mjs";
import { customerRedis } from "../src/http/jail.mjs";

export const config = { runtime: "nodejs" };

/** Roles that may hold an admin-surface session at all; finer grants come later. */
const SESSION_ROLES = new Set(["admin", "support", "billing"]);

export function createLoginHandler({ session = customerSession, roleLookup = getRole, redis = null, env = process.env } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET") return res.status(200).json({ enabled: adminEnabled(), signedIn: isAdmin(req, env), production: env.VERCEL_ENV === "production" });
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    if (!adminEnabled(env)) return res.status(503).json({ error: "admin app is off: LOGMEM_ADMIN_PASSWORD is not set" });
    const password = (req.body && req.body.password) || "";

    // Account-bound path: no password, but a real Clerk session whose account
    // holds an admin-surface role. Break-glass stays on the password path.
    if (!password) {
      try {
        const host = req.headers?.host || "logmem.si";
        const url = `https://${host}${req.url || "/api/login"}`;
        const s = await session(req, { env, url });
        if (s.status !== "signed-in") return res.status(401).json({ error: "sign in required", hint: "sign in through /api/session?signin=1 first, or use the operator password" });
        const role = await roleLookup(s.userId, redis || customerRedis(env));
        if (!role || !SESSION_ROLES.has(role.role)) {
          return res.status(403).json({ error: "role_not_authorized", role: role?.role || "none" });
        }
        res.setHeader("Set-Cookie", issueIdentityCookie(env, s.userId));
        return res.status(200).json({ ok: true, identity: s.userId, role: role.role });
      } catch (e) {
        return res.status(503).json({ error: "identity backend unavailable" });
      }
    }

    if (!checkPassword(password, env)) {
      await new Promise((ok) => setTimeout(ok, 800));
      return res.status(401).json({ error: "That password isn't right." });
    }
    res.setHeader("Set-Cookie", issueCookie(env));
    return res.status(200).json({ ok: true, identity: "break-glass" });
  };
}

export default createLoginHandler();
