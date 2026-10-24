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

import { createClerkClient } from "@clerk/backend";
import { AuthStatus, createRedirect } from "@clerk/backend/internal";

export class ClerkConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClerkConfigError";
  }
}

export const clerkConfigured = (env = process.env) => Boolean(env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY);

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

export async function clerkSession(req, { env = process.env, url } = {}) {
  if (!clerkConfigured(env)) throw new ClerkConfigError("Clerk keys are not set on this deploy");
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
  const origin = new URL(url).origin;
  const state = await clerk.authenticateRequest(webRequest(req, url), { authorizedParties: [origin] });

  if (state.status === AuthStatus.Handshake) return { status: "handshake", headers: [...state.headers.entries()] };

  if (state.status === AuthStatus.SignedIn) {
    const { userId, sessionId } = state.toAuth();
    const email = userId ? primaryEmail(await clerk.users.getUser(userId)) : null;
    if (userId && email) return { status: "signed-in", userId, email, sessionId };
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
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
  const current = session.sessionId ? await clerk.sessions.getSession(session.sessionId) : null;
  if (!current || current.status !== "active" || current.userId !== session.userId) return { status: "signed-out" };
  return session;
}
export async function revokeCustomerSession(sessionId, env = process.env) {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
  return clerk.sessions.revokeSession(sessionId);
}
