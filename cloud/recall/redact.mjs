// redact.mjs — replace secret-shaped strings with "[REDACTED]" before any text
// leaves Redis for the recall index (Qdrant payloads, embedder input, logs).
//
// The patterns follow the secret scan the fleet runs on commits. They are
// deliberately greedy: a false positive costs a word in a search snippet, a
// false negative puts a credential into a derived index. Canonical entries in
// Redis are never modified; only the derived copy is redacted.

export const REDACTED = "[REDACTED]";

// Distinctive vendor prefixes (ghp_, glpat-, AKIA, AIza, ...) match without a
// leading word boundary, so a token glued to other text ("xghp_...") still goes.
// Order matters: whole-block and URL patterns run first so a later, narrower
// pattern does not split them into pieces that leave a fragment behind.
export const PATTERNS = [
  // PEM private key blocks (RSA, EC, OPENSSH, PGP, plain). An unterminated block redacts to the end.
  { name: "private_key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  // Webhook URLs: the path is the credential. The scheme is optional (prose, config).
  { name: "slack_webhook", re: /(?:\bhttps?:\/\/)?\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/gi },
  { name: "discord_webhook", re: /(?:\bhttps?:\/\/)?\b(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/gi },
  // Credentials embedded in a URL: scheme://user:pass@host, including an empty user (redis://:pw@host).
  { name: "url_creds", re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]*:[^\s@/]+@/gi, replace: (_m, scheme) => `${scheme}${REDACTED}@` },
  // JWTs (header.payload.signature, base64url). Before the assigned-secret rule so the whole token goes.
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g },
  // Authorization header values, any scheme: "Authorization: Basic <b64>", "authorization=Bearer <t>".
  {
    name: "auth_header",
    re: /\b(authorization["']?\s*[:=]\s*["']?)(?:(basic|bearer|token|digest|negotiate)\s+)?[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, lead, scheme) => `${lead}${scheme ? `${scheme} ` : ""}${REDACTED}`,
  },
  // AWS access key ids.
  { name: "aws_key_id", re: /(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g },
  // GitHub tokens: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained.
  { name: "github_pat", re: /github_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: "github_token", re: /gh[pousr]_[A-Za-z0-9]{20,}\b/g },
  // GitLab personal access tokens.
  { name: "gitlab_pat", re: /glpat-[A-Za-z0-9_-]{20,}\b/g },
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-, xoxe-).
  { name: "slack_token", re: /xox[abeprs]-[A-Za-z0-9-]{10,}\b/g },
  // Stripe live/test secret and restricted keys.
  { name: "stripe_key", re: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // OpenAI / Anthropic style keys: sk-..., sk-proj-..., sk-ant-...
  { name: "sk_key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  // Google API keys.
  { name: "google_api_key", re: /AIza[0-9A-Za-z_-]{35,}/g },
  // npm, Hugging Face and SendGrid tokens.
  { name: "npm_token", re: /npm_[A-Za-z0-9]{30,}/g },
  { name: "hf_token", re: /\bhf_[A-Za-z0-9]{30,}/g },
  { name: "sendgrid_key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  // ACMI cloud keys (acmi_live_<keyid>_<secret>).
  { name: "acmi_key", re: /acmi_(?:live|test)_[A-Za-z0-9]+_[A-Za-z0-9_-]{8,}/g },
  // Bare "bearer <token>" and "basic <b64>" outside an Authorization header.
  { name: "bearer", re: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_m, word) => `${word} ${REDACTED}` },
  { name: "basic", re: /\b(basic)\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/gi, replace: (_m, word) => `${word} ${REDACTED}` },
  // Assigned secrets: a value of 16+ characters after any name containing
  // key / token / secret / password / pass / pwd (MM_TOKEN_X=, AWS_SECRET_ACCESS_KEY=,
  // "api_key": "...", password: ...). Quotes optional; the value stops at
  // whitespace, a quote, or , ; &.
  {
    name: "assigned_secret",
    re: /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pass|pwd)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)[^\s"'`,;&]{16,}/gi,
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
