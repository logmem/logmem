// GET /api/waitlist[?format=json|csv]: the waitlist for the operator.
//
// Admin only (mayRead, the same gate as /api/view). Without it the answer is
// 401 with no data. JSON gives every row newest first, plus counts by day,
// by source and by plan. An empty source counts as "direct". CSV gives the
// same rows as a download. Nothing here writes.

import { serverRedis, methodNotAllowed } from "../src/http/onboarding.mjs";
import { listSignups } from "../src/http/waitlist-store.mjs";
import { mayRead, adminEnabled } from "../src/http/admin-auth.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

const ROUTE = "/api/waitlist";
const COLUMNS = ["email", "plan", "agents", "ts", "last_ts", "count", "utm_source", "utm_medium", "utm_campaign", "referrer_host", "landing_path"];

/**
 * One CSV cell. Quoted when it holds a comma, a quote or a line break. A
 * leading = + - @ tab or CR gets a ' so a spreadsheet shows it as text, not
 * a formula.
 */
export function csvCell(v) {
  if (v == null) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Counts as [{<name>, n}], most first, then by name. */
function countBy(rows, pick, name) {
  const m = new Map();
  for (const r of rows) {
    const k = pick(r);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => ({ [name]: k, n }));
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createHandler({ redis: getRedis = () => serverRedis(), env = process.env, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!mayRead(req, env)) return res.status(401).json({ error: adminEnabled(env) ? "sign in required" : "admin app is off: LOGMEM_ADMIN_PASSWORD is not set" });
    if (req.method !== "GET") return methodNotAllowed(res, "GET");
    const redis = getRedis();
    if (!redis) return res.status(503).json({ error: "storage not configured on this deployment" });
    try {
      const rows = await listSignups(redis);
      if (String(req.query?.format || "json") === "csv") {
        const iso = (ms) => new Date(ms).toISOString();
        const lines = [COLUMNS.join(",")].concat(rows.map((r) => COLUMNS.map((c) => csvCell(c === "ts" || c === "last_ts" ? iso(r[c]) : r[c])).join(",")));
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="logmem-waitlist-${day(now())}.csv"`);
        res.status(200);
        return res.end(`${lines.join("\r\n")}\r\n`);
      }
      const by_day = countBy(rows, (r) => day(r.ts), "day").sort((a, b) => (a.day < b.day ? -1 : 1));
      res.status(200).json({
        ok: true,
        total: rows.length,
        rows,
        by_day,
        by_source: countBy(rows, (r) => r.utm_source || "direct", "source"),
        by_plan: countBy(rows, (r) => r.plan || "none", "plan"),
      });
    } catch (e) {
      sendServerError(res, ROUTE, e);
    }
  };
}

export default createHandler();
