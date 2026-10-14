// redact.mjs — text that is safe to put in a client-visible warning.
//
// Redis REST `data.error` is upstream text. It can echo the endpoint URL or
// the bearer token. Warnings never forward it raw: a fixed code, and a
// message with URLs, hostnames, and opaque credentials removed.

const URL_RE = /\b(?:https?|redis|rediss):\/\/[^\s)'"<>]+/gi;
const HOST_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s)'"<>]*)?/gi;
const BEARER_RE = /\bbearer\s+\S+/gi;
const ASSIGN_RE = /\b(?:token|password|secret|authorization|api[_-]?key)\b\s*[=:]\s*\S+/gi;
// Continuous credential-shaped blobs. Ordinary Redis words (WRONGTYPE, …) are shorter.
const OPAQUE_RE = /\b[A-Za-z0-9_+/=-]{16,}\b/g;

const CODES = new Set(["read_failed", "unreadable_type"]);

export function sanitizeWarningMessage(raw) {
  let s = String(raw ?? "");
  s = s.replace(URL_RE, "[redacted]");
  s = s.replace(BEARER_RE, "[redacted]");
  s = s.replace(ASSIGN_RE, "[redacted]");
  s = s.replace(HOST_RE, "[redacted]");
  s = s.replace(OPAQUE_RE, "[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) s = "read failed";
  return s.slice(0, 200);
}

/** A partial-read warning. `code` is one of the fixed codes, never upstream text. */
export function readWarning(idField, idValue, err, code = "read_failed") {
  const message = sanitizeWarningMessage(err && typeof err === "object" ? err.message : err);
  return {
    [idField]: idValue,
    code: CODES.has(code) ? code : "read_failed",
    message,
  };
}

const KNOWN_TYPES = new Set(["string", "list", "set", "zset", "hash", "stream"]);

/** Fixed warning for a legacy timeline whose Redis type cannot be read. */
export function unreadableTypeWarning(type) {
  const t = KNOWN_TYPES.has(type) ? type : "unknown";
  return {
    code: "unreadable_type",
    message: sanitizeWarningMessage(`legacy timeline Redis type '${t}' cannot be read`),
  };
}

/** Copy log.warnings (non-enumerable on a readLog result) into a tool's read_warnings. */
export function appendLogWarnings(list, idField, idValue, log) {
  const warnings = log?.warnings;
  if (!Array.isArray(warnings)) return;
  for (const w of warnings) list.push(readWarning(idField, idValue, w?.message, w?.code));
}
