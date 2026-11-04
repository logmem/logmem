/** fleet-truth/v1 Fact + board helpers. */

export const STATUSES = new Set(["verified", "reported", "unknown", "stale"]);
export const SECTIONS = ["clock", "lanes", "launch", "blockers", "infra", "agents", "deltas"];

const REDACT = "[REDACTED]";
const SECRET_RE =
  /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b|\bsk-[A-Za-z0-9]{16,}\b|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function makeFact({ claim, status, observed_at, source, verified_by }) {
  if (!claim || typeof claim !== "string") throw new Error("makeFact: claim required");
  if (!STATUSES.has(status)) throw new Error(`makeFact: bad status (${status})`);
  if (!observed_at) throw new Error("makeFact: observed_at required");
  if (!source || typeof source !== "string") throw new Error("makeFact: source required");
  const fact = { claim, status, observed_at, source };
  if (verified_by != null && verified_by !== "") fact.verified_by = verified_by;
  return fact;
}

export function buildSummary({ refreshed_at, slot, p0, top_blocker, infra }) {
  const blocker = top_blocker && String(top_blocker).trim() ? String(top_blocker).trim() : "none";
  let s = `fleet-truth ${slot || "?"} ${refreshed_at || "?"} | P0=${p0 || "?"} | top_blocker=${blocker} | infra=${infra || "unknown"}`;
  if (s.length >= 200) s = `${s.slice(0, 197)}...`;
  return s;
}

export function scrubSecrets(value) {
  if (typeof value === "string") return value.replace(SECRET_RE, REDACT);
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubSecrets(v);
    return out;
  }
  return value;
}

export function emptyBoard({ refreshed_at, slot, runner, trail }) {
  const sections = Object.fromEntries(SECTIONS.map((k) => [k, { items: [] }]));
  return {
    schema: "fleet-truth/v1",
    refreshed_at,
    slot,
    runner,
    trail,
    ...sections,
  };
}
