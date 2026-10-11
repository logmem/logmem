# Plan: LogMem dogfood Phase 0

Spec: `docs/superpowers/specs/2026-10-11-logmem-dogfood-design.md` (approved 2026-10-11).
Branch: `feat/dogfood-phase0`, stacked on `feat/server-v0`. PR into `feat/server-v0`; never into `main`.

| # | Task | Done when |
|---|---|---|
| 1 | `scripts/bridge-probe.mjs`: run every command LogMem uses on `lm:probe:<ts>:*` keys, then delete them | passes on local Redis :6399; passes on the live Polar bridge |
| 2 | `src/core/mirror.mjs` + store hook (`LOGMEM_MIRROR_ACMI`, `LOGMEM_MIRROR_SPACES`); results report `mirror` | unit tests: shape, ms score, `mirrored_from`, no compat duplicates, fail → queue → drain, space filter |
| 3 | `scripts/dogfood-check.mjs` → `checkup` entry on `job:logmem-dogfood` + `scorecard.json` | unit tests: parity, stuck after 24h, degraded day, pass rule, scorecard shape |
| 4 | `.github/workflows/dogfood-check.yml` (13:00 UTC daily + manual) → commits to `dogfood/scorecard` | the manual run succeeds; scorecard committed |
| 5 | `api/scorecard.mjs` (read allowlist) + `public/scorecard.html` | the preview shows the live checkup history |
| 6 | `scripts/fieldnotes-day.mjs` | integration on :6399 with the mirror on: 0 mismatches |
| 7 | Credentials: GitHub secrets; Vercel preview env (bridge URL/token). Production untouched | the env listing shows preview only |
| 8 | Phase 1: run the Field Notes day live in space `fieldnotes`, then the check | checkup entry: pass; scorecard shows it |
| 9 | Phase 2 kit: MCP config snippets for claude-code / grok-local / claude-engineer; post on ACMI | snippets posted; day-1 handoff claude-code → grok-local verified |
