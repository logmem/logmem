# Fleet Truth Board — Design

Date: 2026-11-04  
Status: approved 2026-11-04 (human:mikey); plan at docs/superpowers/plans/2026-11-04-fleet-truth-board.md  
Space: `madez`  
Owners (design): agent:grok with human:mikey  
Related: channel:agent-coordination, CoS lean checks, LogMem Who/Now/Log

## Problem

Fleet state lives in many places: agent Now slots, job stages, coordination memos, PR/merge chatter, and live probes. Agents and people disagree about what is true because each surface is a partial, time-skewed view. Coordination memos announce work; they are not a single birds-eye source of truth.

## Goal

One cohesive point that answers **what is true now** for the madez fleet, with evidence on every claim. Agents and people check that point first. History stays in the Log. Coordination posts only point at it.

## Non-goals

- Replacing job ownership, asks, or handoffs.
- A full product dashboard rewrite (may come later; this design stores canon in LogMem).
- Waking lean/parked agents to maintain the board.
- Printing secrets, tokens, keys, or email addresses.

## Decision summary

| Choice | Decision |
|---|---|
| Home | `channel:fleet-truth` (Who / Now / Log) |
| Pointer | Short dated memo on `channel:agent-coordination` after each refresh |
| Content | Full fleet ops with truth + evidence |
| Writer | Scheduled job only |
| Cadence | 9 AM / 1 PM / 5 PM ET (aligned with CoS checks), plus on-demand when Mikey asks |

## Architecture

```
probes + jobs + asks + plans + 24h feed
              |
              v
     scheduled truth runner
              |
              +--> overwrite channel:fleet-truth Now
              +--> append channel:fleet-truth Log (checkup)
              +--> memo on channel:agent-coordination (pointer + delta)
```

- **Who** on `channel:fleet-truth`: purpose, scheduler owner id, cadence, schema version, hard rules.
- **Now**: the current birds-eye picture (overwrite each run).
- **Log**: refresh history (never edit; append only).
- **Coordination memo**: announcement only. Canon is the channel Now.

## Now schema

### Summary string

Short plain line (target under 200 characters):

`fleet-truth <slot> <ISO time> | P0=<plan> | top_blocker=<one line or none> | infra=<ok|degraded|unknown>`

### Payload shape

```json
{
  "schema": "fleet-truth/v1",
  "refreshed_at": "2026-11-04T14:00:00Z",
  "slot": "midday",
  "runner": "agent:<id>",
  "trail": "fleetTruth-20261104-midday",
  "clock": { "items": [/* Fact */] },
  "lanes": { "items": [/* Fact */] },
  "launch": { "items": [/* Fact */] },
  "blockers": { "items": [/* Fact */] },
  "infra": { "items": [/* Fact */] },
  "agents": { "items": [/* Fact */] },
  "deltas": { "items": [/* Fact */] }
}
```

### Fact row

Every claim uses this shape:

| Field | Required | Meaning |
|---|---|---|
| `claim` | yes | Plain-English fact |
| `status` | yes | `verified` \| `reported` \| `unknown` \| `stale` |
| `observed_at` | yes | When this reading was taken (ISO) |
| `source` | yes | Job id, PR URL, probe path, or feed trail |
| `verified_by` | no | `agent:…`, `probe:…`, or omit when only reported |

**Status rules**

- `verified` — this run checked the primary source.
- `reported` — carried from another agent or feed; not re-checked this run.
- `unknown` — required input missing or probe failed.
- `stale` — previously known, past freshness window, not re-checked.

### Sections

1. **clock** — Show HN target, CoS check slots, last refresh.
2. **lanes** — P0 / active / parked plans and owners.
3. **launch** — open milestones, due jobs, merge/deploy state that matters now.
4. **blockers** — waits on a person or external system (asks + person handoffs).
5. **infra** — bridge, vault/token health labels (no values), key VM/service health codes.
6. **agents** — core vs lean/parked; unanswered handoff counts for core seats.
7. **deltas** — material changes since the previous refresh trail.

## Scheduler and write rules

### Writer

Exactly one scheduled runner overwrites Now. Ad-hoc agents do not edit Now between runs.

Bootstrap exception: the first seed of Who + Now may be a one-shot supervised run so the channel exists before the timer is wired. After seed, only the scheduler writes Now.

### Cadence

- Fixed: 9 AM, 1 PM, 5 PM America/New_York.
- Optional: manual refresh when Mikey asks.
- Trail id form: `fleetTruth-YYYYMMDD-<slot>` where slot is `morning` \| `midday` \| `closeout` \| `manual`.

### Run order

1. Read plans/lanes, open jobs (`active`/`blocked`), pending asks, person blockers, coordination feed (24h), and allowed live probes.
2. Build the new Now. Mark `verified` only for primary-source checks in this run. Carry unchecked prior facts as `reported` or `stale`. Never invent.
3. Overwrite `channel:fleet-truth` Now. Append Log entry `kind: checkup` with the run trail.
4. Post a short memo on `channel:agent-coordination` with the trail and a one-line delta (or “no material change”).
5. If a required probe fails, publish anyway with that section `unknown`/`stale`. A partial honest board beats silence.

### Correction path

Agents propose corrections with a memo on `channel:fleet-truth` (or a note naming the wrong claim). The next scheduled run re-checks and merges. No hot-patch of Now by core agents.

### Hard rules

- No secrets, tokens, keys, or email in Who, Now, Log, or pointer memos.
- Do not wake lean/parked agents to maintain the board.
- Destructive or spend actions remain outside this board; the board reports state only.

## Read path

| Reader | Behavior |
|---|---|
| Agent start (fleet/operator) | Read `channel:fleet-truth` Now before treating coordination memos as current truth |
| CoS lean check | Cite the latest board trail; do not restate the whole board |
| human:mikey | Open `channel:fleet-truth` (app or MCP view) for the birds-eye |
| Deep dive | Follow `source` / `verified_by` on a Fact into the job, PR, or probe |

Coordination memos remain useful for narrative and handoffs. They are not the source of truth.

## Success criteria

1. After one scheduled run, a core agent can answer P0 lane, top blocker, infra ok/degraded/unknown, and Show HN target from Now alone.
2. Unverified and stale claims are labeled; they are not hidden and not upgraded to verified without a check.
3. Each run leaves a Log checkup and a coordination pointer with the same trail.
4. A second run with no material change still refreshes `refreshed_at` and records deltas as empty or “no material change”.
5. Board content never contains secret values.

## v0 build slice

1. Create `channel:fleet-truth` Who (purpose, cadence, schema `fleet-truth/v1`, scheduler owner placeholder).
2. Supervised seed of Now from a verified sync (bootstrap exception).
3. Post first coordination pointer memo.
4. Document the read convention in the LogMem fleet skill / CoS checklist.
5. Wire the scheduled runner (host + agent id + auth) and retire ad-hoc Now writes.

Out of scope for v0: new LogMem product UI page, automatic PR scraping beyond what jobs already record, waking parked agents.

## Open choices (operator)

These do not block the design; they block wiring the timer:

- Concrete scheduler host and agent id (CoS seat vs ops-center vs dedicated runner).
- Exact probe allowlist for infra (bridge health path, which HTTP checks).
- Freshness windows per section (when `reported` becomes `stale`).

## Approval

Design sections approved in session with human:mikey (2026-11-04): purpose/home, Now schema, scheduler/write rules, read path/success. Full spec approved 2026-11-04. Implementation plan: `docs/superpowers/plans/2026-11-04-fleet-truth-board.md`.
