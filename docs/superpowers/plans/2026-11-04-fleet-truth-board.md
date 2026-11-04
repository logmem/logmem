# Fleet Truth Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a scheduled birds-eye source of truth on `channel:fleet-truth` (Who/Now/Log) with evidence-tagged facts and a short pointer memo on `channel:agent-coordination` after each refresh.

**Architecture:** Follow the dogfood cron pattern. Pure library under `src/fleet-truth/` builds and publishes the board via `createStore` (channel Who/Now cannot go through `logmem_status`/`logmem_bio`, which are agent-only). CLI for dry-run and seed; Vercel Cron handler reuses `CRON_SECRET` auth. Writer identity is `agent:fleet-truth`.

**Tech Stack:** Node 22+, existing `createStore` / `createMemoryRedis` / Vercel Cron (`api/cron/*`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-04-fleet-truth-board-design.md`

## Global Constraints

- Schema id: `fleet-truth/v1`; channel id: `fleet-truth`; writer: `agent:fleet-truth` via `fleet-truth-runner`.
- Cadence: America/New_York slots `morning` (09), `midday` (13), `closeout` (17); trail `fleetTruth-YYYYMMDD-<slot>`.
- No secrets, tokens, keys, or email addresses in Who, Now, Log, or pointer memos.
- Scheduler-only Now writes after bootstrap seed; agents propose corrections via memo on `channel:fleet-truth`.
- Partial publish on probe failure: section status `unknown`/`stale`, never invent.
- Space default: `madez` (env override allowed). Mirror ACMI when the space mirror is on (same as dogfood).

## Review Focus

- Cron with missing/short `CRON_SECRET` must 503 and write nothing.
- A non-slot hour must skip without overwriting Now.
- Overlapping runs for the same `date+slot` must lock-skip, not double-append.
- Payload and summary must scrub secret-shaped strings before write.
- `reported` facts older than the freshness window must become `stale` on the next build.

---

## File map

| Path | Responsibility |
|---|---|
| `src/fleet-truth/schema.mjs` | Fact shape, Now payload, summary line, scrubSecrets |
| `src/fleet-truth/slot.mjs` | `slotFor(nowMs, timeZone)` → slot \| null; trail id; ET date |
| `src/fleet-truth/collect.mjs` | Read jobs, agents, asks, coordination feed, optional probes |
| `src/fleet-truth/build.mjs` | Merge observations + previous Now → new Now + deltas |
| `src/fleet-truth/publish.mjs` | Seed Who, replace Now, append checkup + coordination memo |
| `src/fleet-truth/run.mjs` | `runOnce` + per-slot lock |
| `src/fleet-truth/core.mjs` | Core agent list + default clock claims (Show HN target) |
| `scripts/fleet-truth.mjs` | CLI: `--dry`, `--seed`, `--slot`, `--space` |
| `api/cron/fleet-truth.mjs` | Vercel Cron handler |
| `test/fleet-truth.test.mjs` | Schema/slot/build/collect/publish unit tests |
| `test/fleet-truth-cron.test.mjs` | Cron auth, skip, lock, happy path |
| `docs/RUNBOOK.md` | Ops section for fleet-truth |
| `vercel.json` | Cron schedule entries |

## Locked defaults (spec open choices)

| Choice | Default for v0 |
|---|---|
| Host | Vercel Cron on production (same as dogfood) |
| Agent id | `agent:fleet-truth` |
| Probes | Env `LOGMEM_FLEET_TRUTH_PROBES` = JSON array of `{ "id", "url", "expect_status" }`; empty/unset → infra section one `unknown` fact “no probes configured” |
| Freshness | `reported` → `stale` when `observed_at` older than 36h at build time |
| Core agents | `chief-of-staff`, `grok-local`, `ops-center`, `bentley`, `hermes`, `grok`, `opencode`, `antigravity`, `claude-code` in `core.mjs` |
| Show HN clock seed | `Wed Nov 18 2026 9:30 America/New_York` as a `reported` claim until a job source verifies it |

---

### Task 1: Schema, scrub, summary, slot

**Files:**
- Create: `src/fleet-truth/schema.mjs`
- Create: `src/fleet-truth/slot.mjs`
- Test: `test/fleet-truth.test.mjs`

**Interfaces:**
- Produces: `makeFact({ claim, status, observed_at, source, verified_by? })`, `buildSummary({ refreshed_at, slot, p0, top_blocker, infra })`, `scrubSecrets(value)`, `emptyBoard({ refreshed_at, slot, runner, trail })`, `slotFor(nowMs, timeZone = "America/New_York")` → `"morning"|"midday"|"closeout"|null`, `trailId(dateEt, slot)`, `etDate(nowMs)`

- [ ] **Step 1: Write failing tests** for `makeFact` required fields, `buildSummary` under 200 chars with the four fields, `scrubSecrets` redacting Bearer tokens / `sk-` / email-shaped strings in nested objects, `slotFor` at 09:00/13:00/17:00 ET returning slots and 10:00 ET returning null, `trailId("2026-11-04","midday") === "fleetTruth-20261104-midday"`.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test test/fleet-truth.test.mjs`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `schema.mjs` and `slot.mjs`**

Use `Intl.DateTimeFormat` with `timeZone: "America/New_York"` for hour and calendar date. Status enum exactly: `verified|reported|unknown|stale`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test test/fleet-truth.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add src/fleet-truth/schema.mjs src/fleet-truth/slot.mjs test/fleet-truth.test.mjs
git commit -m "feat(fleet-truth): schema, scrub, summary, and ET slots"
```

---

### Task 2: Build board from observations + previous Now

**Files:**
- Create: `src/fleet-truth/build.mjs`
- Create: `src/fleet-truth/core.mjs`
- Modify: `test/fleet-truth.test.mjs`

**Interfaces:**
- Consumes: Task 1 schema/slot helpers; freshness 36h constant `FRESHNESS_MS = 36 * 3600e3`
- Produces: `buildBoard({ observations, previous, nowMs, slot, runner })` → `{ summary, now }` where `now` matches `fleet-truth/v1` sections `clock|lanes|launch|blockers|infra|agents|deltas`

- [ ] **Step 1: Write failing tests**
  - Verified observation lands as `verified` with `verified_by`.
  - Previous `reported` fact within 36h kept as `reported` when absent from observations.
  - Previous `reported` fact older than 36h becomes `stale`.
  - Never upgrades `reported`/`stale` to `verified` without a matching observation.
  - `deltas.items` lists claim text that changed status or appeared/disappeared; empty board-to-same yields one delta claim `no material change` with status `verified`.
  - Summary uses P0 from lanes, top blocker from blockers[0], infra `ok|degraded|unknown` from infra facts.

- [ ] **Step 2: Run the new tests — expect FAIL**

- [ ] **Step 3: Implement `buildBoard` and `core.mjs` defaults** (core agent ids + Show HN seed claim helper `defaultClockClaims(nowMs)`)

- [ ] **Step 4: Run `node --test test/fleet-truth.test.mjs` — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/fleet-truth/build.mjs src/fleet-truth/core.mjs test/fleet-truth.test.mjs
git commit -m "feat(fleet-truth): build board with evidence and deltas"
```

---

### Task 3: Collect observations from the store (+ optional probes)

**Files:**
- Create: `src/fleet-truth/collect.mjs`
- Modify: `test/fleet-truth.test.mjs`

**Interfaces:**
- Consumes: `store` (`createStore` shape: `list`, `getWho`, `getNow`, `readLog`)
- Produces: `collectObservations(store, { nowMs, coreAgents, probes?, fetchImpl? })` → `{ observations: Observation[] }`
- Observation: `{ section, fact: Fact }` with Fact from Task 1

- [ ] **Step 1: Write failing tests** using `createMemoryRedis` + `createStore`:
  - Job at stage `blocked` with `blocked_on` → blockers section fact, status `verified`, source `job:<id>`.
  - Job at stage `active` with Who title → launch fact.
  - Job Who `details.plan` / lane fields when present → lanes fact; if no plan metadata, emit one lanes `unknown` fact `plan metadata unavailable`.
  - Core agent with unanswered handoff in last 48h of its log (kind `handoff`, `to` matching agent, no later `accepted`/`feedback` with declined on same origin) → agents fact counting unanswered.
  - Coordination feed entries in last 24h do not become canon facts by themselves (collect may ignore or mark `reported` only when explicitly mapped — v0: do not copy feed into Now).
  - Probe `{ id:"bridge", url:"http://example/health", expect_status:200 }` with fetch 200 → infra `verified`; fetch 401 → infra `unknown` (not invented healthy).
  - `scrubSecrets` applied to all claim strings before return.

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement `collectObservations`**

Ask scan: for each core agent, read log reverse limit 200; treat kind `approval` entries still open via store key `ask:<trail>` if `GET lm:{space}:ask:{trail}` exists and no `decision:` twin — if ask registry helpers are awkward, v0 may derive pending asks only from agent Now `waiting_on` and job stage `blocked` with `blocked_on.type === "decision"`. Prefer job blockers + `waiting_on` over a full ask index walk.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/fleet-truth/collect.mjs test/fleet-truth.test.mjs
git commit -m "feat(fleet-truth): collect jobs, agents, and probes"
```

---

### Task 4: Publish Who / Now / checkup / pointer

**Files:**
- Create: `src/fleet-truth/publish.mjs`
- Modify: `test/fleet-truth.test.mjs`

**Interfaces:**
- Consumes: `buildBoard` result; `store`
- Produces: `ensureWho(store, { nowMs })`, `publishBoard(store, { summary, now, trail, nowMs, seedWho? })` → `{ trail, checkup_ts, pointer_ts }`

- [ ] **Step 1: Write failing tests**
  - `ensureWho` writes channel Who with `schema: "fleet-truth/v1"`, `purpose`, `cadence`, `owner: "agent:fleet-truth"`, no secret fields.
  - `publishBoard` calls replace-style Now write (`replaceNow` if available, else DEL+`setNow`) with fields `{ summary, board: <payload>, refreshed_at, slot, trail, updated_at }`.
  - Appends `kind: "checkup"` on `channel:fleet-truth` with `by: "agent:fleet-truth"`, matching `trail`, summary under 1000 chars.
  - Appends `kind: "memo"` on `channel:agent-coordination` with same `trail`, summary naming the slot and one-line delta.
  - Second publish with identical board still writes new checkup (history) and refreshes `refreshed_at`.

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement `publish.mjs`** (byline `fleet-truth (via fleet-truth-runner)`, via `fleet-truth-runner`)

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/fleet-truth/publish.mjs test/fleet-truth.test.mjs
git commit -m "feat(fleet-truth): publish channel Who, Now, checkup, pointer"
```

---

### Task 5: `runOnce` + CLI

**Files:**
- Create: `src/fleet-truth/run.mjs`
- Create: `scripts/fleet-truth.mjs`
- Modify: `test/fleet-truth.test.mjs`

**Interfaces:**
- Produces: `runOnce(redis, { space, nowMs, slot?, dry?, probes?, seedWho? })` → `{ ok, skipped?, trail?, summary?, space }`
- Lock key: `lm:{space}:fleet-truth:lock:{etDate}:{slot}` SET NX EX 600
- CLI flags: `--space`, `--slot morning|midday|closeout|manual`, `--dry`, `--seed`, `--now <iso>` (test only)

- [ ] **Step 1: Write failing tests**
  - When `slotFor` is null and no forced `slot`, return `{ skipped: "not_a_slot" }` and do not write.
  - Forced `slot: "manual"` always runs; trail uses `manual`.
  - Lock held → `{ skipped: "locked" }`, no second checkup.
  - `dry: true` returns built summary and writes nothing.
  - Happy path returns `ok: true` and readable Now via `getNow("channel","fleet-truth")`.

- [ ] **Step 2: Implement `runOnce` and CLI** (CLI uses `descriptorFromEnv` like dogfood)

- [ ] **Step 3: Run `node --test test/fleet-truth.test.mjs` — expect PASS**

- [ ] **Step 4: Commit**

```bash
git add src/fleet-truth/run.mjs scripts/fleet-truth.mjs test/fleet-truth.test.mjs
git commit -m "feat(fleet-truth): runOnce with lock and CLI dry/seed"
```

---

### Task 6: Vercel Cron handler

**Files:**
- Create: `api/cron/fleet-truth.mjs`
- Create: `test/fleet-truth-cron.test.mjs`
- Modify: `vercel.json`

**Interfaces:**
- Reuse `cronAuthorized` / `CRON_SECRET_MIN` pattern from `api/cron/dogfood-check.mjs` (import shared helpers or copy the same constant-time check; prefer extracting only if a one-line import works without a broad refactor — copying the two small helpers into this file is acceptable for v0 to avoid drive-by refactors).
- Env: `LOGMEM_FLEET_TRUTH_SPACES` default `madez`; `LOGMEM_FLEET_TRUTH_PROBES` optional JSON.
- Schedule: `"0 13,14,17,18,21,22 * * *"` on `/api/cron/fleet-truth` (covers ET 9/13/17 in both DST offsets); handler no-ops via `not_a_slot` when hour is the DST twin that is not local 9/13/17.

- [ ] **Step 1: Write failing cron tests** mirroring dogfood: 503 without secret, 401 wrong auth, 200 with skip on non-slot `now`, 200 write on slot `now`, lock skip.

- [ ] **Step 2: Implement handler + add cron entry to `vercel.json`**

- [ ] **Step 3: Run `node --test test/fleet-truth-cron.test.mjs test/fleet-truth.test.mjs` — expect PASS**

- [ ] **Step 4: Commit**

```bash
git add api/cron/fleet-truth.mjs test/fleet-truth-cron.test.mjs vercel.json
git commit -m "feat(fleet-truth): Vercel cron endpoint and schedule"
```

---

### Task 7: Docs, skill read convention, live seed gate

**Files:**
- Modify: `docs/RUNBOOK.md` (new section “Fleet truth board”)
- Modify: `docs/superpowers/specs/2026-11-04-fleet-truth-board-design.md` (status → approved; note plan path)
- Modify or add: fleet read note in `docs/RUNBOOK.md` and a short pointer in the public skill checkout if this repo carries one; otherwise add `docs/launch/fleet-truth-read.md` with the agent start rule: on fleet/operator start, `logmem_view` / feed `channel:fleet-truth` before acting on coordination rumor.

**Interfaces:**
- Ops commands documented:
  - Dry: `node scripts/fleet-truth.mjs --space madez --slot manual --dry`
  - Seed: `node scripts/fleet-truth.mjs --space madez --slot manual --seed`
  - Cron curl same shape as dogfood section 7

- [ ] **Step 1: Write RUNBOOK + read-convention doc; mark design approved**

- [ ] **Step 2: Commit docs**

```bash
git add docs/RUNBOOK.md docs/superpowers/specs/2026-11-04-fleet-truth-board-design.md docs/launch/fleet-truth-read.md
git commit -m "docs(fleet-truth): runbook, read convention, design approved"
```

- [ ] **Step 3: Live seed (operator-gated)** — requires Mikey GO before any production write. On approve: run `--seed` against prod credentials, then `logmem_view` / Redis readback of Who, Now, latest checkup, and coordination pointer. Record trail in a coordination memo. Do not enable reliance on cron until seed readback passes.

- [ ] **Step 4: After first successful cron slot in prod, post coordination memo that ad-hoc Now writes are retired**

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| `channel:fleet-truth` Who/Now/Log | 4, 5 |
| Evidence Fact fields + statuses | 1, 2 |
| Sections clock/lanes/launch/blockers/infra/agents/deltas | 2, 3 |
| Scheduler-only writer + cadence | 5, 6 |
| Coordination pointer memo | 4 |
| Partial publish / no invent | 2, 3 |
| No secrets | 1, 3 (scrub) + Review Focus |
| Read path documentation | 7 |
| Bootstrap seed exception | 5 CLI `--seed`, 7 live gate |
| Success: answer P0/blocker/infra/Show HN from Now | 2 summary + 3/4 content |

## Out of scope (do not implement in this plan)

- New LogMem web dashboard page
- Automatic GitHub PR scraping
- Waking lean/parked agents
- Changing `logmem_status` to write channel Now
