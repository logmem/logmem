// admin-auth.mjs — the operator login for the web app (/app and /api/view).
//
// One password, set by the operator as LOGMEM_ADMIN_PASSWORD in the deploy's
// env. Never in the repo, never in chat. A correct password gets an HMAC-signed,
// HttpOnly cookie valid for 12 hours. No password set = the admin app is off.

import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export const COOKIE = "lm_admin";
const TTL_S = 12 * 3600;

function secret(env) {
  const s = env.LOGMEM_ADMIN_SECRET || (env.LOGMEM_ADMIN_PASSWORD ? createHash("sha256").update(`logmem-admin:${env.LOGMEM_ADMIN_PASSWORD}`).digest("hex") : "");
  return s;
}

const sign = (payload, key) => createHmac("sha256", key).update(payload).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function adminEnabled(env = process.env) {
  return Boolean(env.LOGMEM_ADMIN_PASSWORD);
}

export function checkPassword(given, env = process.env) {
  if (!adminEnabled(env)) return false;
  return safeEqual(createHash("sha256").update(String(given)).digest(), createHash("sha256").update(env.LOGMEM_ADMIN_PASSWORD).digest());
}

export function issueCookie(env = process.env, now = Date.now()) {
  const exp = Math.floor(now / 1000) + TTL_S;
  const value = `${exp}.${sign(String(exp), secret(env))}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_S}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function readCookie(req) {
  const raw = String(req.headers?.cookie || "");
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === COOKIE) return part.slice(i + 1);
  }
  return null;
}

export function isAdmin(req, env = process.env, now = Date.now()) {
  if (!adminEnabled(env)) return false;
  const v = readCookie(req);
  if (!v) return false;
  const [exp, mac] = v.split(".");
  if (!exp || !mac || Number(exp) * 1000 < now) return false;
  return safeEqual(mac, sign(exp, secret(env)));
}

/**
 * May this request read space data? Production: only a signed-in admin (and
 * never when no password is set). Preview/dev: Vercel's own login already
 * gates the whole deployment, so allow.
 */
export function mayRead(req, env = process.env) {
  if (env.VERCEL_ENV === "production" || env.LOGMEM_CUSTOMER_DASHBOARD === "1") return isAdmin(req, env);
  return adminEnabled(env) ? isAdmin(req, env) : true;
}

/** Spaces the web app may show. */
export function viewSpaces(env = process.env) {
  return String(env.LOGMEM_VIEW_SPACES || "fieldnotes,madez").split(",").map((s) => s.trim()).filter(Boolean);
}
