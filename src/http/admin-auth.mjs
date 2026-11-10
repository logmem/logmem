// admin-auth.mjs — the operator login for the web app (/app and /api/view).
//
// One password, set by the operator as LOGMEM_ADMIN_PASSWORD in the deploy's
// env. Never in the repo, never in chat. A correct password gets an HMAC-signed,
// HttpOnly cookie valid for 12 hours. No password set = the admin app is off.

import { getSecret } from "../lib/secrets.mjs";
import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export const COOKIE = "lm_admin";
const TTL_S = 12 * 3600;
export const BREAK_GLASS_TTL_S = 3600; // 1 hour emergency break-glass token

export class AdminSecretMissingError extends Error {
  constructor(msg = "LOGMEM_ADMIN_SECRET is required in production") {
    super(msg);
    this.name = "AdminSecretMissingError";
    this.status = 503;
    this.code = "admin_secret_missing";
  }
}

export function secret(env = process.env) {
  const adminSecret = getSecret("LOGMEM_ADMIN_SECRET", env);
  if (env.VERCEL_ENV === "production" && !adminSecret) {
    throw new AdminSecretMissingError();
  }
  const base = adminSecret || "";
  const pw = getSecret("LOGMEM_ADMIN_PASSWORD", env) || "";
  if (!base && !pw) return "";
  if (base && pw) {
    return createHash("sha256").update(`logmem-admin:${base}:${pw}`).digest("hex");
  }
  if (base) return base;
  return createHash("sha256").update(`logmem-admin:${pw}`).digest("hex");
}

const sign = (payload, key) => createHmac("sha256", key).update(payload).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function adminEnabled(env = process.env) {
  return Boolean(getSecret("LOGMEM_ADMIN_PASSWORD", env));
}

export function checkPassword(given, env = process.env) {
  if (!adminEnabled(env)) return false;
  return safeEqual(createHash("sha256").update(String(given)).digest(), createHash("sha256").update(getSecret("LOGMEM_ADMIN_PASSWORD", env)).digest());
}

/**
 * Slice 2 identity: the cookie carries the admin's own id so every admin
 * action can attribute to a real account instead of the shared password.
 *   legacy:  {exp}.{mac}                     -> "break-glass" attribution
 *   identity: {exp}.{identity}.{mac}          -> the account id (user_...)
 * Identity cookies stay valid for 12h TTL. Break-glass emergency cookies expire in 1h.
 */
export const BREAK_GLASS = "break-glass";

/** The verified admin identity on this request, or null when not an admin. */
export function adminIdentity(req, env = process.env, now = Date.now()) {
  if (!adminEnabled(env)) return null;
  const v = readCookie(req);
  if (!v) return null;
  const parts = String(v).split(".");
  const key = secret(env);
  if (!key) return null;

  if (parts.length === 3) {
    const [exp, identity, mac] = parts;
    if (!identity || Number(exp) * 1000 < now) return null;
    return safeEqual(mac, sign(`${exp}.${identity}`, key)) ? identity : null;
  }
  if (parts.length === 2) {
    const [exp, mac] = parts;
    const expMs = Number(exp) * 1000;
    if (expMs < now) return null;
    if (expMs > now + BREAK_GLASS_TTL_S * 1000) return null; // expire legacy over-long tokens
    return safeEqual(mac, sign(exp, key)) ? BREAK_GLASS : null;
  }
  return null;
}

/** Issue an identity-bearing admin cookie for a Clerk user id. */
export function issueIdentityCookie(env = process.env, identity, now = Date.now()) {
  const exp = Math.floor(now / 1000) + TTL_S;
  const payload = `${exp}.${String(identity).slice(0, 64)}`;
  const value = `${payload}.${sign(payload, secret(env))}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_S}`;
}

export function issueCookie(env = process.env, now = Date.now()) {
  const exp = Math.floor(now / 1000) + BREAK_GLASS_TTL_S;
  const value = `${exp}.${sign(String(exp), secret(env))}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${BREAK_GLASS_TTL_S}`;
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
  return adminIdentity(req, env, now) !== null;
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
