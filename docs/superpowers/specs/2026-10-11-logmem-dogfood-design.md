# LogMem dogfood: design

Date: 2026-10-11 · Approved in brainstorm by Mikey · Work item: `logmem-server-v0-20261011` · ACMI cid: `logmemDogfoodPlan-1791740000000`

## Goal

Get real work flowing through LogMem with an audit trail, without breaking the fleet.
This is sub-project 1 of 4. Hosted access, the data migration and the public launch each get their own design.

## Decisions

| # | Decision |
|---|---|
| D1 | Two stages: a scripted sandbox team first (space `fieldnotes`), then the Mac-local agents doing real work (space `madez`) |
| D2 | During dogfood, every LogMem write in `madez` is mirrored to `acmi:madez:*` in ACMI shape, behind a flag. This overrides spec item O5 for the dogfood window only |
| D3 | Pass bar = 7 days at the agreed volume **and** one real deliverable shipped through LogMem |
| D4 | Audit = a daily automated check that writes `checkup` entries + `scorecard.json`, plus a private scorecard page |
| D5 | The deliverable is LogMem v0 itself: spec final (Oct 14), server PR (Oct 21), and the migration `--apply` PR **opened and reviewed**. Running `--apply` stays a separate Mikey GO |
| D6 | The mirror runs inside the store at write time. The check runs on GitHub Actions |

## Phases

| Phase | When | What | Exit |
|---|---|---|---|
| 0 Build | Oct 11–13 | mirror, check, Actions workflow, scorecard page, sandbox script, bridge probe. PRs only, preview only | tests green; bridge probe passes on the live bridge |
| 1 Sandbox | Oct 13 | the Field Notes day in space `fieldnotes`, mirror off | 0 mismatches; scorecard shows the run |
| 2 Real work | Oct 13–19 | claude-code, claude-engineer, grok-local (Codex optional) over stdio; space `madez`, `LOGMEM_ACMI_COMPAT=1`, `LOGMEM_MIRROR_ACMI=1`; deliverable coordinated on `job:logmem-v0-ship` | pass bar (below) |
| 3 Gate | Oct 20–21 | Mikey reviews the scorecard + evidence | GO: start hosted access + cutover planning. NO-GO: roll back |

### Pass bar (all must hold)

- 7 consecutive days. A day passes only if the check ran **and** found 0 mirror mismatches, 0 degraded sessions and 0 handoffs unanswered for more than 24h
- ≥ 3 distinct agents active per day
- ≥ 1 cross-agent handoff per day, each answered with `accepted`
- 0 reports from ACMI-side agents of a missed handoff
- `job:logmem-v0-ship` reaches `done`, with the spec, server PR and migration PR linked

## Components

| Unit | Purpose | Depends on |
|---|---|---|
| `src/core/mirror.mjs` | Given an `lm` write (slot, ns, id, payload), write its ACMI twin (`timeline`/`signals`/`profile`, ACMI fields and kinds, ms score, `mirrored_from: "lm"`). On failure, push the twin to `lm:{space}:mirror:retry` and drain that queue on the next call | `vocab.mjs`, `keys.mjs` |
| `store.mjs` (change) | Call the mirror after each successful `lm` write when `LOGMEM_MIRROR_ACMI=1` and the space is in `LOGMEM_MIRROR_SPACES` (default `madez`). Report `mirror: ok \| failed \| off` back to the tool | mirror |
| `scripts/bridge-probe.mjs` | Exercise every Redis command LogMem uses on `lm:probe:*` keys, then delete them. Exit non-zero on any refusal | backend |
| `scripts/dogfood-check.mjs` | Daily audit: parity, agents, handoffs/accepts, unanswered handoffs over 24h (writes `stuck`), degraded sessions. Writes one `checkup` entry to `job:logmem-dogfood` and `docs/dogfood/scorecard.json` | store |
| `.github/workflows/dogfood-check.yml` | Run the check daily at 13:00 UTC and on manual dispatch; commit `scorecard.json` to the dedicated branch `dogfood/scorecard` (never `main`). The bridge creds live in repo secrets `LOGMEM_REST_URL` / `LOGMEM_REST_TOKEN` | check |
| `api/scorecard.mjs` + `public/scorecard.html` | Read-only page: 7-day pass/fail strip, parity per day, open handoffs, deliverable status. It reads the `checkup` entries live from `lm:madez:job:logmem-dogfood:log`. The preview env holds the read-write bridge creds (Mikey approved 2026-10-11; the Polar bridge has a single token). The endpoint wraps them in the dry-run read-command allowlist, so the page can't write. The creds are set for **preview only**, never production. Served on the preview branch alias behind Vercel SSO. `scorecard.json` in git is the tamper-evident copy | store |
| `scripts/fieldnotes-day.mjs` | The Action Map day (quill / atlas / relay / tally), scripted against the server API | server |

`scorecard.json` shape:

```json
{ "generated_at": "...", "space": "madez",
  "days": [{ "date": "2026-10-13", "ran": true, "pass": true,
             "agents": ["claude-code","grok-local","claude-engineer"],
             "entries": 41, "mirror_mismatches": 0, "degraded_sessions": 0,
             "handoffs": 2, "accepted": 2, "unanswered_24h": 0 }],
  "deliverable": { "job": "logmem-v0-ship", "stage": "active", "links": [] } }
```

## Data flow

- **A Mac agent writes:** an `lm:madez:*` write, then the mirror writes the `acmi:madez:*` twin. VM agents see it on their next ACMI read.
- **A VM agent writes:** to `acmi:madez:*` only. Mac agents see it through compat reads.
- **No duplicates:** compat reads skip a legacy entry with the same ts, trail and summary as an `lm` entry. The mirror only copies native `lm` writes, never compat reads, so there are no echo loops.

## Error handling

| Failure | Behaviour |
|---|---|
| The mirror write fails | The tool returns `ok: true, mirror: "failed"`; the twin is queued and retried on the next call; still-unmirrored entries count as mismatches (that day fails) |
| The `lm` write fails | `ok: false`, nothing mirrored |
| The bridge refuses a command | Caught by `bridge-probe` in Phase 0, before any real use |
| The bridge is down | stdio goes degraded (in-memory). Agents stop and report; the day fails |
| The check didn't run | That day is a gap and counts as failed; it can be re-run manually |
| A handoff is unanswered for more than 24h | The check writes `stuck` (mirrored to ACMI, so the midday sweep sees it) |
| Rollback | `LOGMEM_MIRROR_ACMI=0` and point the agents back to ACMI. Nothing is lost, since every write already exists in ACMI |

## Testing

- **Unit:** mirror shape + ms score + marker; no duplicate under compat; fail → queue → drain; space filter; check parity / stuck-after-24h / degraded day / scorecard shape
- **Integration** (local Redis :6399): the Field Notes day with the mirror on → every step in both prefixes, 0 mismatches; the probe passes
- **Live:** probe on the Polar bridge (`lm:probe:*`, deleted after) → Phase 1 run → Phase 2 day-1 handoff claude-code → grok-local, with the ACMI twin and Brief verified
- **Gate evidence:** 7 `checkup` entries, 7 `scorecard.json` commits, 7 Actions run logs, the `logmem-v0-ship` log, grok-local's review on #1/#2

## Credentials

| Where | What | Scope |
|---|---|---|
| GitHub Actions secrets | `LOGMEM_REST_URL`, `LOGMEM_REST_TOKEN` | the daily check (writes `checkup` entries) |
| Vercel env, **preview only** | `LOGMEM_REST_URL`, `LOGMEM_REST_TOKEN` | read-write, approved by Mikey 2026-10-11; `/api/scorecard` is read-only in code |
| Vercel env, production | none | `logmem.vercel.app` stays credential-free |
| Mac stdio agents | `LOGMEM_REST_URL`, `LOGMEM_REST_TOKEN` (or `LOGMEM_REDIS_URI`) in each MCP config | read-write |

## Gates kept

PRs only, no merge to main. Vercel preview only. No npm publish. No migration `--apply` in this sub-project. The only live writes are `lm:*` (+ mirror twins in `acmi:madez:*`) by approved dogfood agents, plus the probe's own `lm:probe:*` keys.

## Out of scope

Hosted OAuth/deploy Redis, migration of historical data, the fleet-wide cutover, the trademark/public launch. Each gets its own design.
