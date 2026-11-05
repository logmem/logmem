import { makeFact } from "./schema.mjs";

/** Core seats the board always reports on. */
export const CORE_AGENTS = [
  "chief-of-staff",
  "grok-local",
  "ops-center",
  "bentley",
  "hermes",
  "grok",
  "opencode",
  "antigravity",
  "claude-code",
];

/** Seed clock claims until a job source verifies them. */
export function defaultClockClaims(nowMs) {
  return [
    makeFact({
      claim: "Show HN Wed Nov 18 2026 9:30 America/New_York",
      status: "reported",
      observed_at: new Date(nowMs).toISOString(),
      source: "core:show-hn-seed",
    }),
  ];
}
