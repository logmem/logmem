// src/core/secrets-guard.mjs — refuse entries that carry secret values (spec: secret handling P0, guard rails).
// Entries carry references (an Infisical path and name), never values.

export const SECRET_REFUSED = "refused: the entry looks like it holds a secret value. Write the secret's name or path, never the value";

const RULES = [
  ["aws_access_key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["stripe_key", /\b[rs]k_(live|test)_[0-9A-Za-z]{16,}\b/],
  ["github_token", /\bgh[pousr]_[0-9A-Za-z]{30,}\b/],
  ["slack_token", /\bxox[abpors]-[0-9A-Za-z-]{10,}\b/],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer_jwt", /\bBearer\s+eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/],
  ["assigned_secret", /\b[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[=:]\s*["']?[0-9A-Za-z+/_.-]{20,}/],
];

export function findSecret(text) {
  if (typeof text !== "string" || text.length < 16) return null;
  for (const [name, re] of RULES) if (re.test(text)) return name;
  return null;
}

function* strings(v, depth = 0) {
  if (depth > 8 || v == null) return;
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x, depth + 1);
  else if (typeof v === "object") for (const [k, x] of Object.entries(v)) { yield k; yield* strings(x, depth + 1); }
}

export function assertNoSecret(field, value) {
  for (const s of strings(value)) {
    const rule = findSecret(s);
    if (rule) throw new Error(`${SECRET_REFUSED} (${field}: ${rule})`);
  }
}
