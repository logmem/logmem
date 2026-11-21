// src/http/integrations.mjs — the secrets loader and live test for the integrations screen
// (Phase 6.2 slice 5, "secrets loader first" per the layered design spec, layer 1).
//
// Rules that shape this file:
//   - Presence only: a key's NAME and whether it is set. No value, prefix or
//     fingerprint ever leaves this module, so the screen cannot leak a secret.
//   - Registry is the truth: only integrations LogMem actually runs appear.
//     No aspirational rows, no invented numbers (Phase rules).
//   - "test" performs one real outbound check with the configured credential
//     and records the last error for GET to surface. Success clears it.
import { getSecret } from "../lib/secrets.mjs";

export const REGISTRY = [
  {
    id: "email",
    label: "Email sending (Resend)",
    keys: ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
    testable: true,
    test: async ({ fetchImpl, env }) => {
      const apiKey = getSecret("RESEND_API_KEY", env);
      if (!apiKey) return { ok: false, error: "not_configured" };
      const res = await fetchImpl("https://api.resend.com/api-keys", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) return { ok: false, error: "credential_rejected" };
      return { ok: false, error: `upstream_${res.status}` };
    },
  },
  {
    id: "auth",
    label: "Sign-in (Clerk)",
    keys: ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY"],
    testable: false, // presence is the honest signal; a live Clerk ping needs a customer session
    test: async () => ({ ok: false, error: "not_testable" }),
  },
];

const present = (env, name) => {
  // getSecret enforces the registered-secret registry and throws for names
  // outside it; plain env vars (RESEND_FROM_EMAIL, publishable keys) are read
  // directly, the same split resend.mjs and clerk.mjs already use.
  try {
    if (getSecret(name, env)) return true;
  } catch {
    /* unregistered name: fall through to the direct env read */
  }
  return Boolean(env[name]);
};

/** Presence-only view of every integration credential. Never returns values. */
export function loadIntegrationSecrets(env = process.env) {
  return REGISTRY.map((inv) => ({
    id: inv.id,
    label: inv.label,
    configured: inv.keys.every((k) => present(env, k)),
    testable: inv.testable,
    keys: inv.keys.map((name) => ({ name, present: present(env, name) })),
  }));
}

export const lastErrorKey = (id) => `lm:integrations:${id}:last-error`;

/** Run one integration's live test. Records {error, at} in redis on failure,
 *  clears it on success. Returns a plain verdict, never the upstream body. */
export async function testIntegration(id, { env = process.env, redis, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const inv = REGISTRY.find((r) => r.id === id);
  if (!inv) return { ok: false, error: "unknown_integration" };
  if (!inv.testable) return { ok: false, error: "not_testable" };
  let verdict;
  try {
    verdict = await inv.test({ fetchImpl, env });
  } catch {
    verdict = { ok: false, error: "unreachable" };
  }
  if (redis) {
    if (verdict.ok) await redis("DEL", lastErrorKey(inv.id));
    else await redis("SET", lastErrorKey(inv.id), JSON.stringify({ error: verdict.error, at: now() }));
  }
  return verdict;
}

/** Last recorded failure per integration (null when never failed or cleared). */
export async function loadLastErrors(redis) {
  const out = {};
  for (const inv of REGISTRY) {
    try {
      const raw = await redis("GET", lastErrorKey(inv.id));
      out[inv.id] = raw ? JSON.parse(raw) : null;
    } catch {
      out[inv.id] = null;
    }
  }
  return out;
}
