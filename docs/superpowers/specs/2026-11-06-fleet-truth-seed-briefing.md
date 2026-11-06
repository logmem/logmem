# Fleet truth — seed briefing

Date: 2026-11-06  
Owner: agent:grok  
Space: `madez`  
Related: job `fleet-truth-seed-ui`, parent `fleet-truth-board` (done), PR 236 (`a597240`)  
UI design: still owned by agent:claude-code (approach A lean)

## Purpose

Supervised one-shot seed of `channel:fleet-truth` Who + first Now before the Vercel cron owns refreshes. UI can land after seed. Seed does not wait on the UI package.

## Preconditions (verified 2026-11-06)

| Check | Result |
|---|---|
| PR 236 on main | MERGED `a597240` |
| `api/cron/fleet-truth` on prod | HTTP **401** (route live, auth closed) |
| `channel:fleet-truth` Who/Now | empty |
| Dry-run (`slot: manual`, `dry: true`, `seedWho: true`, memory redis + prod probes) | `ok: true`, trail `fleetTruth-YYYYMMDD-manual`, summary produced |

## Who (write once on seed)

- purpose: birds-eye canon for madez fleet truth with evidence
- cadence: 9 AM / 1 PM / 5 PM America/New_York (+ manual)
- schema: `fleet-truth/v1`
- scheduler owner: placeholder until timer wiring (open choice)
- hard rules: no secrets/tokens/keys/emails; no waking parked agents; agents do not overwrite Now after seed

## First Now (seed)

Use CLI:

```bash
node scripts/fleet-truth.mjs --space madez --slot manual --seed
# after dry check:
# node scripts/fleet-truth.mjs --space madez --slot manual --dry --seed
```

Expect:

- trail `fleetTruth-<YYYYMMDD>-manual`
- sections: clock, lanes, launch, blockers, infra, agents, deltas
- Fact status: `verified` | `reported` | `unknown` | `stale`
- Show HN clock seed present as `reported` until re-verified
- coordination pointer memo on `channel:agent-coordination` with the same trail

## Dry-run evidence (2026-11-06)

Local memory dry-run with probes to `https://logmem.si/api/health` and POST `/api/cron/fleet-truth`:

- `ok: true`, not skipped
- summary like: `fleet-truth manual … | P0=? | top_blocker=none | infra=degraded`
- infra item: probe unexpected HTTP 401 marked `unknown` (expected without `CRON_SECRET`)
- clock: Show HN Wed Nov 18 2026 9:30 America/New_York (`reported`)

## Live seed checklist

1. Confirm Mikey GO on ask for live `--seed` (this briefing is not the GO).
2. Run `--dry --seed` against madez REST with production-readable credentials (no secret print).
3. Run live `--seed` once.
4. Read back `channel:fleet-truth` Who + Now via `logmem_view`.
5. Confirm coordination pointer memo exists with matching trail.
6. Leave cron to refresh at next ET slot (needs `CRON_SECRET` ≥ 32 chars in Vercel).

## Out of scope

- UI implementation (claude-code design package)
- Merging other PRs
- Waking parked agents
- Printing secrets

## Open choices (still operator)

- Concrete scheduler host / agent id for the runner identity
- Exact probe allowlist beyond health + cron
- Freshness windows when `reported` ages to `stale`
