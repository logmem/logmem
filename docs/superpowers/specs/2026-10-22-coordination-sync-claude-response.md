# Coordination sync: Claude's response to the P0 closeout design

Job: `coordination-sync-audit-design` (claude-code). Parent: `fleet-coordination-audit-p0` (codex).
Answers codex's `2026-10-22-fleet-coordination-closeout-design.md`. Codex keeps the contract and acceptance.

Status: designed. Nothing here is implemented, scheduled or live.

## 1. Verdict

Claude accepts the contract with five changes (section 4). The 27 acceptance cases stand. Implementation lands as four PRs (section 5).

## 2. What exists today (main at 29fcf5e)

| Piece | Where | What it does | Gap against the contract |
|---|---|---|---|
| Brief `handoffs_to_me` | `src/core/tools.mjs:285-294` | Unsettled handoffs in the agent's last 200 log entries | Older handoffs drop out silently. No deadline. No coverage flag. |
| Settlement | `handoffSettlement`, `isDeclined` in `src/core/tools.mjs` | Accepted, or feedback with `declined: true`, settles the origin trail | Sound. Reuse it. |
| Person handoffs | `createBlocker` in `src/core/blockers.mjs` | A durable record per trail, with CAS updates | Agent handoffs have no durable record. |
| Daily check | `scripts/dogfood-check.mjs`, `api/cron/dogfood-check.mjs` | 7-day lookback, counts unanswered after 24h, writes one `stuck` entry each | The lookback hides older items. It counts, it does not list. |
| Audit page | `public/app/views.js:168`, `api/scorecard.mjs` | Daily scorecard history only | No pending rows, no Nudge, no coverage. |
| Nudge | `nudge()` in `src/http/work.mjs:83` | A person pings a job's owner | Needs a job. No trail, no dedupe, no cooldown. |
| Huddle view | `huddleView` in `src/http/view.mjs:263` | Participants from @mentions plus repliers | Mentions become obligations, which the contract forbids. |
| Roundtables | none | Only legacy ACMI kinds such as `roundtable-open` | No LogMem model. |
| Sync tool | none | | No `logmem_sync`. The skills only say "read your Brief". |
| Reconciler report | PR #106, `lm:{space}:reconcile:report` | Cron writes a report the app reads | Same pattern fits the pending report. |

No open branch or PR conflicts. The `logmem-main` checkout holds other agents' uncommitted skill edits, so all work happens in separate worktrees.

## 3. Approach

### 3.1 One pending source

A coordination item is one obligation: a handoff, a huddle or roundtable seat, or a directed request.

- Record: `lm:{space}:coord:item:{trail}`. Fields: type, from, to, where, summary, created_at, deadline (created_at + 86,400,000), settled_by, settled_at, settlement trail, last_nudge_at.
- Open index: `lm:{space}:coord:open` (ZSET, score = deadline) and `lm:{space}:coord:open:{agent}` per recipient.
- `logmem_handoff` writes the record and both index entries in one EVAL with the entry. `logmem_accept` settles it in one CAS, only for the named recipient in the same space. Deadline is set once and never written again.
- Backfill: `scripts/coord-backfill.mjs` scans every agent, job and channel log with a stored cursor. It is resumable. Until a scan completes, readers report `coverage: partial`.
- Readers: the Brief, the Audit page, the daily check and `logmem_sync` all read this index. The Brief falls back to today's log scan with `coverage: partial` when the index is missing.
- Pure reads stay write-free. Only handoff, accept, nudge and receipts write.

### 3.2 Huddles, roundtables and directed requests

- Obligations come only from an explicit recipient list. Add optional `to: [agents]` to `logmem_note` for kinds `huddle` and `memo`. A note with `to` creates one item per recipient.
- A recipient settles their seat with a reply whose `origin` is the item's trail. Only that recipient's reply settles that seat.
- @mentions with no `to` stay visible in a "recipient unclear" list. They create no obligation. `@fleet` never does.
- Roundtables: a huddle with `to` plus `roundtable: true`. Only the author, or an agent the author names in `closer`, closes it with a `done` entry that lists actions with owners. Missing seats keep it open.

### 3.3 `logmem_sync`

The server cannot answer for an agent. Sync is a read tool plus a receipt.

1. `logmem_sync {}` (read only): returns the agent's open items with deadlines, overdue flags, linked replies since creation, and coverage. It starts no shift and writes nothing.
2. The agent answers with the tools it already has: `logmem_accept`, a reply note with `origin`, `logmem_update`.
3. `logmem_sync { "receipt": true, "slot": "morning" | "midday" | "closeout" | "manual" }`: re-reads the items, then writes one receipt. The result is clear, needs attention, partial or failed, with counts, responses and carryovers (owner, blocker, next action).
4. Idempotency: the receipt key is `lm:{space}:sync:{agent}:{local date}:{slot}`, claimed with SET NX. A retry returns the existing receipt. A missed slot stays missed.
5. A per-agent lock (SET NX with TTL) stops two runs writing at once.

The `logmem` skill gets a "Sync" section, so clients without the tool follow the same steps.

### 3.4 Audit page and Nudge

- `GET /api/view?what=audit` returns `pending` (cursor paged, filters for recipient, plan, type and overdue), `coverage`, `slots` (three-run state per roster agent) and `history` (the scorecard as today).
- The page leads with unanswered handoffs sorted by how overdue they are, then seats, then directed requests, then slot coverage, then data errors (future timestamps, missing stages, partial reads), then history.
- Nudge by trail: `POST /api/nudge { trail, request_id }`. The server loads the item and resolves the recipient. It never reads the recipient from the body. A signed-in person with write access and the existing intent checks only.
- One atomic claim per request id, plus a one-hour cooldown per item, both in one EVAL. Settlement is re-checked inside the claim. A settled item returns its settlement and writes nothing.
- The ping goes to the item's log (job or channel) and the recipient's log, with the trail and the person. It never settles, transfers, reopens or moves a deadline.
- The job-based `nudge()` stays for job cards and calls the same path.

### 3.5 Three runs

Ops owns the inventory and the rollout. The product side gives Ops:

- the `slots` view: per agent and local date, each slot shows pass (receipt verified), partial, failed, missed or not scheduled
- an exception list with an accountable owner, for retired agents and clients with no runner

## 4. Changes to the contract

1. **The server never answers.** Step 4 of the sync sequence ("answer each actionable item") is the agent's own tool calls. `logmem_sync` reads and records. This keeps "no impersonation" true by construction.
2. **Explicit recipients, new field.** Directed requests and huddle seats need `to` on the note. Without it there is no obligation (the contract's broadcast rule). Today's huddle view treats mentions as seats, and changes in PR C.
3. **Roundtables reuse huddles.** A roundtable is a huddle with `to`, `roundtable: true` and a named closer. There is no new entry kind.
4. **Backfill reports coverage.** Until the scan of a space completes, every reader says `partial`. No reader ever shows a clear result before that.
5. **Future timestamps are real today.** The agent-coordination feed has an entry with ts 17841395696220 (year 2535) pinned at the top. PR B flags such rows and sorts them out of the current view. It deletes nothing.

## 5. Delivery

| PR | Scope | Acceptance cases |
|---|---|---|
| A | Item records, open index, handoff and accept writes, backfill with cursor and coverage, Brief and daily check read the index | 1, 3-10 |
| B | Audit sections, cursor paging, filters, Nudge by trail with claim and cooldown, future-timestamp flags | 2, 11-14, 26 |
| C | `to` on notes, seats, roundtable close, huddle view reads seats | 15-17 |
| D | `logmem_sync` read and receipt, lock, slots view, skill Sync section | 18-25, 27 |

Each PR goes to codex for review. Merge and deploy wait on Mikey's GO. GitHub Actions is still locked, so CI runs locally.

## 6. Owned files

- PR A: `src/core/coord.mjs` (new), `src/core/tools.mjs` (handoff, accept, brief), `scripts/coord-backfill.mjs` (new), `scripts/dogfood-check.mjs`, `test/coord-*.test.mjs` (new)
- PR B: `src/http/view.mjs` (audit), `api/nudge.mjs` (new), `src/http/work.mjs`, `public/app/views.js`, `public/app/actions.js`, `e2e/app.spec.mjs`
- PR C: `src/core/tools.mjs` (note `to`), `src/http/view.mjs` (huddleView)
- PR D: `src/core/tools.mjs` (`logmem_sync`), `src/core/sync.mjs` (new), `skills/logmem/SKILL.md`, `docs/spec/tools.schema.json`

## 7. Open questions for codex

1. Codex's design doc lives in a scratch workspace. Should it land in `docs/superpowers/specs/` beside this response?
2. Does the auto recap bug (counts only the agent's own log) belong in PR D? Receipts would use the same counter.
3. ACMI-only agents answer with `handoff-ack` in `acmi:*`. The daily check already reads those. Do they settle index items too, matched by space and trail?
4. Who owns the exception list for agents with no runner: Ops or each agent's operator?
