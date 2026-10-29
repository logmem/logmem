import { withCustomerDashboard } from '../src/http/customer-dashboard.mjs';
// /api/connections — a managed account owner sees and disconnects their apps.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-one-click-connect-design.md, 4.7.
//   GET ?signin=1                         top-level sign-in through Clerk, back to /connections
//   GET                                   -> { email, space, plan, apps: [...] }  (401 { signin } when signed out)
//   POST { action: "disconnect", fid }    -> { disconnected: true|false }
//
// Who: the person signed in with Clerk. Only their own tenant's apps are listed
// or revoked. Writes need "X-LogMem-Intent: connections" plus a same-origin
// check. Disconnect revokes the app's whole token family and frees the agent's
// Free slot when no other app of the tenant uses that agent.

import { clerkSession, clerkConfigured } from "../src/http/clerk.mjs";
import { accountFor } from "../src/http/accounts.mjs";
import { customerRedis } from "../src/http/jail.mjs";
import { serverRedis } from "../src/http/onboarding.mjs";
import { listManagedApps, revokeManagedApp } from "./oauth/_lib/storage.mjs";
import { namespaceFor } from "../cloud/tenants/index.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 15 };
export const INTENT = "connections";
const SIGNIN = "/api/connections?signin=1";

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers?.host || "");
  } catch {
    return false;
  }
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(String(req.body || ""));
  } catch {
    return null;
  }
}

const defaultDeps = () => ({
  ready: () => clerkConfigured(),
  session: (req, url) => clerkSession(req, { url }),
  redis: () => customerRedis(),
  waitlistRedis: () => serverRedis(),
});

export function createHandler(getDeps = defaultDeps) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    try {
      const d = getDeps();
      let redis;
      try {
        if (d.ready && !d.ready()) throw new Error("not configured");
        redis = d.redis();
      } catch {
        return res.status(503).json({ error: "LogMem accounts are not set up on this deploy" });
      }
      const host = String(req.headers?.host || "logmem.si");
      const url = new URL(req.url || "/api/connections", `https://${host}`);

      // Top-level sign-in: Clerk's hosted page, then back to /connections.
      if (req.method === "GET" && url.searchParams.get("signin") === "1") {
        const s = await d.session(req, url.toString());
        if (s.status === "handshake") {
          const cookies = [];
          for (const [k, v] of s.headers || []) {
            if (k.toLowerCase() === "set-cookie") cookies.push(v);
            else res.setHeader(k, v);
          }
          if (cookies.length) res.setHeader("Set-Cookie", cookies);
          res.statusCode = 307;
          return res.end();
        }
        res.statusCode = 302;
        res.setHeader("Location", s.status === "signed-in" ? "/connections" : s.signInUrl);
        return res.end();
      }

      const s = await d.session(req, url.toString());
      if (s.status !== "signed-in") return res.status(401).json({ error: "sign in required", signin: SIGNIN });
      const acct = await accountFor({ clerkUserId: s.userId, email: s.email }, { redis, waitlistRedis: d.waitlistRedis ? d.waitlistRedis() : null });
      if (acct.waitlist) return res.status(200).json({ email: s.email, waitlist: true, apps: [] });

      if (req.method === "GET") {
        const apps = (await listManagedApps(acct.tenant)).map((a) => ({ fid: a.fid, app: a.client_name || "App", agent: a.agent, created_at: a.created_at, last_used: a.last_used, last_call_at: a.last_call_at || null, last_call_agent: a.last_call_agent || null }));
        return res.status(200).json({ email: s.email, space: acct.space, plan: acct.plan, apps });
      }
      if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
      if (String(req.headers?.["x-logmem-intent"] || "") !== INTENT || !sameOrigin(req)) {
        return res.status(403).json({ error: `missing or wrong X-LogMem-Intent header (expected '${INTENT}' from this site)` });
      }
      const b = body(req);
      if (!b || b.action !== "disconnect") return res.status(400).json({ error: "action must be disconnect" });
      const rec = await revokeManagedApp(acct.tenant, String(b.fid || ""), {
        beforeRemove: async (app) => {
          const stillUsed = (await listManagedApps(acct.tenant)).some((a) => a.fid !== app.fid && !a.disconnected && a.agent === app.agent);
          if (!stillUsed) await redis("SREM", `lm:${namespaceFor(acct.tenant)}:agents`, app.agent);
        },
      });
      if (!rec) return res.status(200).json({ disconnected: false });
      return res.status(200).json({ disconnected: true });
    } catch (e) {
      return sendServerError(res, "connections", e);
    }
  };
}

export default withCustomerDashboard(createHandler());
