// mcp-server-helpers.mjs — pure validation/guard helpers for ACMI MCP.
// Mirror of ~/.openclaw/skills/acmi/mcp-server-helpers.mjs (kept in sync;
// this copy lives next to the HTTP MCP route in api/_lib/).

export function validateKeySegments(...segments) {
  for (const s of segments) {
    if (s === undefined || s === null) {
      throw new Error(`Invalid key segment: received ${s} (undefined/null)`);
    }
    const v = String(s);
    if (!v) throw new Error(`Invalid key segment: empty string`);
    if (v === "undefined" || v === "null") {
      throw new Error(`Invalid key segment: literal "${v}" — likely an unsubstituted JS variable`);
    }
    if (/[*?[\]]/.test(v)) {
      throw new Error(`Invalid key segment: "${v}" contains a glob character (* ? [ ]) — could widen a SCAN pattern`);
    }
    if (v.includes(":")) {
      throw new Error(`Invalid key segment: "${v}" contains ":" — would corrupt key structure`);
    }
    if (v.length > 200) {
      throw new Error(`Invalid key segment: ${v.length} chars exceeds 200 — looks like status text or error message bleeding into key`);
    }
  }
}

/**
 * Channel ids are nested by design: "client:duane:duane-lead-pipeline" and
 * "shared:team-pulse" are real ids in the roster. Each segment keeps the
 * plain-id rules and the colon is the nesting separator. lm:{space}:channel:
 * {id}:{slot} has a fixed prefix and a fixed suffix, so a nested id cannot
 * collide with the key structure. Empty segments, leading or trailing
 * colons, whitespace, globs, control characters and oversized ids are still
 * refused. Every other namespace keeps the strict no-colon rule.
 */
export function validateChannelId(id) {
  if (id === undefined || id === null) {
    throw new Error(`Invalid key segment: received ${id} (undefined/null)`);
  }
  const v = String(id);
  if (!v) throw new Error(`Invalid key segment: empty string`);
  if (v === "undefined" || v === "null") {
    throw new Error(`Invalid key segment: literal "${v}" — likely an unsubstituted JS variable`);
  }
  if (/[*?[\]]/.test(v)) {
    throw new Error(`Invalid channel id: "${v}" contains a glob character (* ? [ ]) — could widen a SCAN pattern`);
  }
  if (v.length > 200) {
    throw new Error(`Invalid channel id: ${v.length} chars exceeds 200 — looks like status text bleeding into the id`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]*(:[A-Za-z0-9][A-Za-z0-9._@+-]*)*$/.test(v)) {
    throw new Error(`Invalid channel id: "${v.slice(0, 64)}" — segments are letters, digits, '.', '_', '@', '+', '-' joined by ':' with no empty, leading or trailing segment`);
  }
  return v;
}

export function validateJson(s, fieldName) {
  if (typeof s !== "string") {
    throw new Error(`${fieldName} must be a JSON string, got ${typeof s}`);
  }
  try { JSON.parse(s); }
  catch (e) { throw new Error(`${fieldName} is not valid JSON: ${e.message}`); }
}

const PROTECTED_PREFIXES = [
  "acmi:registry:",
  "acmi:notion-sync:",
];

export function isProtectedKey(key) {
  if (!key) return true;
  return PROTECTED_PREFIXES.some(p => key.startsWith(p));
}
