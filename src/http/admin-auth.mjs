// admin-auth.mjs — the operator login for the web app (/app and /api/view).
//
// One password, set by the operator as LOGMEM_ADMIN_PASSWORD in the deploy's
// env. Never in the repo, never in chat. A correct password gets an HMAC-signed,
// HttpOnly cookie valid for 12 hours. No password set = the admin app is off.
//
// Clerk (managed) sign-in is also accepted: a signed-in Clerk user may read
// when their email is in LOGMEM_ADMIN_EMAILS or they own a tenant.

import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { descriptorFromEnv, fromDescriptor } from "../lib/backend.mjs";
import { clerkConfigured, clerkSession } from "./clerk.mjs";
import { accountFor } from "./accounts.mjs";

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

// ---- Clerk injection (tests) ----
let adminDeps = null;
function setAdminDeps(d) { adminDeps = d; }
export function __setAdminDepsForTests(d) { setAdminDeps(d); }
export const __setAdminClerkDepsForTests = __setAdminDepsForTests;
export const __setClerkDepsForTests = __setAdminDepsForTests;
export const __setClerkSessionForTests = (fn) => setAdminDeps({ session: fn });

function getDeps() {
  if (adminDeps) return adminDeps;
  return {};
}

function reqUrl(req) {
  const proto = String(req.headers?.["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "localhost";
  return `${proto}://${host}${req.url || "/"}`;
}

function clerkConfiguredSafe(env) {
  const deps = getDeps();
  const fn = deps.ready || deps.clerkConfigured || deps.isConfigured;
  if (typeof fn === "function") {
    try { return fn.length === 0 ? Boolean(fn()) : Boolean(fn(env)); } catch { return false; }
  }
  try { return clerkConfigured(env); } catch { return false; }
}

async function callSession(req, env, url) {
  const deps = getDeps();
  const fn = deps.session || deps.clerkSession;
  if (typeof fn === "function") {
    const attempts = [[], [req], [req, url], [req, { env, url }], [req, env, url]];
    for (const args of attempts) {
      try {
        const r = await fn(...args);
        if (r && typeof r === "object" && "status" in r) return r;
      } catch {
        // try next signature
      }
    }
  }
  try { return await clerkSession(req, { env, url }); } catch { return null; }
}

function defaultRedis(env) {
  const d = descriptorFromEnv(env);
  const b = d && fromDescriptor(d);
  return b ? b.redis : null;
}

async function resolveAccount(session, env) {
  const deps = getDeps();
  const redisFactory = deps.redis;
  const redis = typeof redisFactory === "function" ? redisFactory() : (redisFactory || defaultRedis(env));
  if (!redis) return null;
  const af = deps.accountFor || accountFor;
  try {
    return await af({ clerkUserId: session.userId, email: session.email }, { redis, env });
  } catch {
    return null;
  }
}

function adminEmails(env) {
  return String(env.LOGMEM_ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Returns an array of spaces a signed-in Clerk user may view, or null if the
 * request is not a signed-in Clerk user (fall back to password path).
 */
export async function clerkViewSpaces(req, env = process.env) {
  if (!clerkConfiguredSafe(env)) return null;
  const url = reqUrl(req);
  const session = await callSession(req, env, url);
  if (!session || session.status !== "signed-in") return null;
  const emails = adminEmails(env);
  if (emails.includes(session.email)) return viewSpaces(env);
  const acct = await resolveAccount(session, env);
  if (acct && !acct.waitlist) return [acct.space];
  return [];
}

export async function mayRead(req, env = process.env) {
  const passwordAllowed = (env.VERCEL_ENV === "production")
    ? isAdmin(req, env)
    : (adminEnabled(env) ? isAdmin(req, env) : true);
  if (passwordAllowed) return true;

  const spaces = await clerkViewSpaces(req, env);
  if (spaces === null) return false;
  return true;
}

/** Spaces the web app may show. */
export function viewSpaces(env = process.env) {
  return String(env.LOGMEM_VIEW_SPACES || "fieldnotes,madez").split(",").map((s) => s.trim()).filter(Boolean);
}
