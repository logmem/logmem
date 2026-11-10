// clerk.mjs — who is signing in, for managed LogMem accounts.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-one-click-connect-design.md,
// 4.3 and 11. LogMem keeps its own OAuth server; Clerk only says who the
// person is. The session is checked on the server with @clerk/backend, and
// sign-in happens on Clerk's hosted pages (Account Portal), which send the
// person back to the same authorize URL. No Clerk front-end SDK on LogMem pages.
//
// clerkSession(req, { env, url }) returns one of:
//   { status: "signed-in", userId, email }   email is the verified primary email
//   { status: "handshake", headers }          send these headers with a 307 (Clerk sets its cookies)
//   { status: "signed-out", signInUrl }       redirect here; Clerk returns to `url`

import { getSecret } from "../lib/secrets.mjs";
import { createClerkClient } from "@clerk/backend";
import { AuthStatus, createRedirect } from "@clerk/backend/internal";

export class ClerkConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClerkConfigError";
  }
}

export const clerkConfigured = (env = process.env) => Boolean(getSecret("CLERK_SECRET_KEY", env) && env.CLERK_PUBLISHABLE_KEY);

/** Return the Clerk Account Portal origin named by a public publishable key. */
export function clerkFrontendForKey(key = "") {
  if (!/^pk_(test|live)_[A-Za-z0-9+/=]+$/.test(key)) return "";
  const domain = Buffer.from(key.replace(/^pk_(test|live)_/, ""), "base64").toString("utf8").replace(/\$$/, "");
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain) || domain.includes("..")) return "";
  return "https://" + domain;
}

function webRequest(req, url) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (v == null) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  }
  return new Request(url, { method: "GET", headers });
}

/** The verified primary email of a Clerk user, or null. */
export function primaryEmail(user) {
  const list = Array.isArray(user?.emailAddresses) ? user.emailAddresses : [];
  const primary = list.find((e) => e.id === user.primaryEmailAddressId) || null;
  if (!primary || primary.verification?.status !== "verified") return null;
  return String(primary.emailAddress || "") || null;
}

/**
 * Resolve an id that may be a native Clerk id or a migration external_id
 * (dev-instance users carry their old id in the session claim). getUser first,
 * then an external_id filter, and only accept a row whose external_id really
 * matches. A transient provider error reads as null, so a broken provider
 * signs the person out instead of erroring the route.
 */
export async function userById(clerk, id) {
  if (!id) return null;
  try {
    return await clerk.users.getUser(id);
  } catch {
    // fall through to the external_id lookup
  }
  try {
    const list = await clerk.users.getUserList({ externalId: [id] });
    const rows = Array.isArray(list?.data) ? list.data : Array.isArray(list) ? list : [];
    return rows.find((u) => (u.external_id || u.externalId) === id) || null;
  } catch {
    return null;
  }
}

/**
 * Origins a Clerk token may legitimately name as its authorized party (azp).
 * Dev-instance tokens often carry the instance domain from the publishable key
 * rather than the application origin, so the gate accepts both forms.
 */
export function partyOrigins(publishableKey = "") {
  try {
    const domain = Buffer.from(String(publishableKey).replace(/^pk_(test|live)_/, ""), "base64")
      .toString("utf8").split("$")[0];
    if (!domain || !domain.includes(".")) return [];
    const origins = [`https://${domain}`];
    if (domain.includes(".clerk.")) origins.push(`https://${domain.replace(".clerk.", ".")}`);
    return origins;
  } catch {
    return [];
  }
}

export async function clerkSession(req, { env = process.env, url, client } = {}) {
  if (!clerkConfigured(env)) throw new ClerkConfigError("Clerk keys are not set on this deploy");
  const clerk = client || createClerkClient({ secretKey: getSecret("CLERK_SECRET_KEY", env), publishableKey: env.CLERK_PUBLISHABLE_KEY });
  const origin = new URL(url).origin;
  const parties = [origin];
  for (const p of partyOrigins(env.CLERK_PUBLISHABLE_KEY)) if (!parties.includes(p)) parties.push(p);
  let state;
  try {
    state = await clerk.authenticateRequest(webRequest(req, url), { authorizedParties: parties });
  } catch (e) {
    console.error(`[clerk] authenticateRequest threw: ${e?.message || e}`);
    throw e;
  }
  // A handshake that resolves to a bare signed-out answer strands the browser
  // in a portal loop. Log the reason so the next report names the check that
  // failed instead of guessing.
  if (new URL(url).searchParams.has("__clerk_handshake")
      && state.status !== AuthStatus.Handshake
      && !state.headers.has("location") && !state.headers.has("set-cookie")) {
    console.error(`[clerk] handshake unresolved: ${state.reason || state.message || "signed-out with no directives"}`);
  }

  // A resolved handshake can already be signed in. Its response directives
  // still have to reach the browser before another request uses the session.
  if (state.status === AuthStatus.Handshake || state.headers.has("location") || state.headers.has("set-cookie")) {
    const headers = [...state.headers.entries()].filter(([name]) => name.toLowerCase() !== "set-cookie");
    for (const cookie of state.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
    if (!state.headers.has("location")) {
      if (!state.headers.has("set-cookie")) throw new ClerkConfigError("Clerk handshake has no redirect or cookies");
      const destination = new URL(url);
      for (const name of ["__clerk_handshake", "__clerk_handshake_nonce", "__clerk_db_jwt", "__clerk_help"]) destination.searchParams.delete(name);
      headers.push(["location", destination.toString()]);
    }
    return { status: "handshake", headers };
  }

  if (state.status === AuthStatus.SignedIn) {
    const { userId, sessionId } = state.toAuth();
    // userId may be a migration external_id carried by the session claim.
    const user = await userById(clerk, userId);
    const email = user ? primaryEmail(user) : null;
    if (userId && email) return { status: "signed-in", userId, email, sessionId };
  }

  const entry = new URL(url);
  if (entry.pathname === '/api/session' && entry.searchParams.get('signin') === '1') {
    return { status: 'signed-out', signInUrl: origin + '/sign-in?returnTo=' + encodeURIComponent(entry.searchParams.get('returnTo') || '/app') };
  }
  if (entry.pathname === '/api/connections' && entry.searchParams.get('signin') === '1') {
    return { status: 'signed-out', signInUrl: origin + '/sign-in?returnTo=%2Fconnections' };
  }
  const { redirectToSignIn } = createRedirect({
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    baseUrl: origin,
    redirectAdapter: (to) => to,
  });
  return { status: "signed-out", signInUrl: String(redirectToSignIn({ returnBackUrl: url })) };
}

/** Customer routes also check provider revocation, rather than trusting a cached JWT. */
export async function customerSession(req, options = {}) {
  const session = await clerkSession(req, options);
  if (session.status !== "signed-in") return session;
  const env = options.env || process.env;
  const clerk = options.client || createClerkClient({ secretKey: getSecret("CLERK_SECRET_KEY", env), publishableKey: env.CLERK_PUBLISHABLE_KEY });
  const current = session.sessionId ? await clerk.sessions.getSession(session.sessionId) : null;
  if (!current || current.status !== "active") return { status: "signed-out" };
  if (current.userId !== session.userId) {
    // The token claim may carry external_id (dev-instance migration). Accept
    // the session only when Clerk's own user record maps it back exactly.
    const mapped = await userById(clerk, current.userId);
    if (!mapped || (mapped.external_id || mapped.externalId) !== session.userId) return { status: "signed-out" };
  }
  return session;
}
export async function revokeCustomerSession(sessionId, env = process.env) {
  const clerk = createClerkClient({ secretKey: getSecret("CLERK_SECRET_KEY", env), publishableKey: env.CLERK_PUBLISHABLE_KEY });
  return clerk.sessions.revokeSession(sessionId);
}
