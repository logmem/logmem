// secrets.mjs — the one reader of secrets.
//
// Spec: docs/superpowers/specs/2026-11-06-layered-backend-frontend-ux-design.md
// (Layer 1, job l1-secrets-loader-infisical). Every credential the runtime
// reads comes through getSecret() and nowhere else:
// test/secrets-loader.test.mjs fails the build on a direct
// `something.SECRET_NAME` read outside this file, and on a getSecret()
// call for a name that is not registered here.
//
// Source: process.env today. The seam for the self-hosted Infisical vault
// (needs Mikey's go for spend) is inside getSecret(): a vault read with
// env fallback swaps in there and no call site changes.
//
// describeSecrets() is the receipt surface for key-guardian work: names,
// source and last-rotated dates only, never values. "rotated: null" means
// the date was never recorded, not that the value was never rotated —
// record the date here when you rotate.
//
// No imports: the acmi-bridge image (cloud/bridge/Dockerfile) copies only
// src/lib and runs with zero dependencies, so this file must stay pure.

export const REGISTRY = Object.freeze({
  ACMI_BRIDGE_TOKEN: { source: "env", rotated: null },
  ACMI_BRIDGE_TOKEN_SHA256: { source: "env", rotated: null },
  ACMI_METER_REDIS_TOKEN: { source: "env", rotated: null },
  ACMI_REDIS_TOKEN: { source: "env", rotated: null },
  ACMI_REDIS_URI: { source: "env", rotated: null },
  BLOB_READ_WRITE_TOKEN: { source: "env", rotated: null },
  CLERK_SECRET_KEY: { source: "env", rotated: null },
  CRON_SECRET: { source: "env", rotated: null },
  LOGMEM_ADMIN_PASSWORD: { source: "env", rotated: "2026-11-06" },
  LOGMEM_ADMIN_SECRET: { source: "env", rotated: null },
  LOGMEM_CUSTOMER_REDIS_URI: { source: "env", rotated: null },
  LOGMEM_DECIDE_SECRET: { source: "env", rotated: null },
  LOGMEM_DEPLOY_REDIS_URI: { source: "env", rotated: null },
  LOGMEM_DEPLOY_REST_TOKEN: { source: "env", rotated: null },
  LOGMEM_DIRECT_AUTH_TOKEN: { source: "env", rotated: null },
  LOGMEM_GITHUB_TOKEN: { source: "env", rotated: null },
  LOGMEM_REDIS_URI: { source: "env", rotated: null },
  LOGMEM_REST_TOKEN: { source: "env", rotated: null },
  RESEND_API_KEY: { source: "env", rotated: null },
  UPSTASH_REDIS_REST_TOKEN: { source: "env", rotated: null },
});

/**
 * Read a registered secret. `obj` defaults to process.env and exists for
 * test doubles, config blobs (api/?config=) and per-tenant env objects —
 * the registry governs the NAME, the caller says where the value lives.
 * A missing value returns undefined (callers keep their configured-or-not
 * checks); an unregistered name throws, so a typo cannot silently read
 * nothing.
 */
export function getSecret(name, obj = process.env) {
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, name)) {
    throw new Error(`secrets.mjs: "${name}" is not a registered secret. Add it to REGISTRY before reading it.`);
  }
  return obj[name];
}

/** Every registered secret name, sorted. For checks and receipts. */
export function secretNames() {
  return Object.keys(REGISTRY).sort();
}

/**
 * Names, source and last-rotated dates. Never values — this is what a
 * LogMem receipt or a debug dump may print.
 */
export function describeSecrets() {
  return secretNames().map((name) => ({
    name,
    source: REGISTRY[name].source,
    rotated: REGISTRY[name].rotated,
  }));
}
