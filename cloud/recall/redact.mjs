// redact.mjs — replace secret-shaped strings with "[REDACTED]" before any text
// leaves Redis for the recall index (Qdrant payloads, embedder input, logs).
//
// The patterns follow the secret scan the fleet runs on commits. They are
// deliberately greedy: a false positive costs a word in a search snippet, a
// false negative puts a credential into a derived index. Canonical entries in
// Redis are never modified; only the derived copy is redacted.

export const REDACTED = "[REDACTED]";

// Order matters: whole-block and URL patterns run first so a later, narrower
// pattern does not split them into pieces that leave a fragment behind.
export const PATTERNS = [
  // PEM private key blocks (RSA, EC, OPENSSH, PGP, plain).
  { name: "private_key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  // Credentials embedded in a URL: scheme://user:pass@host
  { name: "url_creds", re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, replace: (_m, scheme) => `${scheme}${REDACTED}@` },
  // AWS access key ids.
  { name: "aws_key_id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g },
  // GitHub tokens: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained.
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  // GitLab personal access tokens.
  { name: "gitlab_pat", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-, xoxe-).
  { name: "slack_token", re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g },
  // Stripe live/test secret and restricted keys.
  { name: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // OpenAI / Anthropic style keys: sk-..., sk-proj-..., sk-ant-...
  { name: "sk_key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  // Google API keys.
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35,}/g },
  // ACMI cloud keys (acmi_live_<keyid>_<secret>).
  { name: "acmi_key", re: /\bacmi_(?:live|test)_[A-Za-z0-9]+_[A-Za-z0-9_-]{8,}\b/g },
  // Authorization: Bearer <token>, and bare "bearer <token>".
  { name: "bearer", re: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_m, word) => `${word} ${REDACTED}` },
  // key=, token=, secret= (and :, and common variants) followed by a 32+ char
  // hex or base64 run. Quotes optional.
  {
    name: "assigned_secret",
    re: /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)[A-Za-z0-9+/_=-]{32,}/gi,
    replace: (_m, lead) => `${lead}${REDACTED}`,
  },
];

/** Replace every secret-shaped run in `text`. Non-strings are stringified; null/undefined become "". */
export function redact(text) {
  if (text == null) return "";
  let out = String(text);
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    out = p.replace ? out.replace(p.re, p.replace) : out.replace(p.re, REDACTED);
  }
  return out;
}

/** True when `text` contains anything redact() would replace. */
export function hasSecret(text) {
  return redact(text) !== String(text ?? "");
}
