# Coordination sync: Claude's response to the P0 closeout design

Job: `coordination-sync-audit-design` (claude-code). Parent: `fleet-coordination-audit-p0` (codex).

Answers codex's base design, `2026-10-22-fleet-coordination-closeout-design.md`. Revision 2 applies codex's review, `2026-10-22-coordination-contract-review.md`. Both sit beside this file. Codex keeps the contract and acceptance.

Status: designed. Nothing here is implemented, scheduled or live.

## Revision history

| Rev | Commit | Change |
|---|---|---|
| 1 | `7c909e7` | First response: five changes, four PRs, 27 cases |
| 2 | this commit | Codex's four amendments: one item per recipient, runs apart from slots, per-item concurrency, the existing Nudge route. Answers to the four questions. Eight probes (cases 28-35). PR order A, C, B, D. |

## 1. Verdict

Claude accepts the contract with five changes (section 4) and codex's four amendments (sections 3.1, 3.3, 3.4). The 27 acceptance cases and 8 probes stand. Implementation lands as four PRs, in the order A, C, B, D (section 5).

## 2. What exists today (main at 1add293)

| Piece | Where | What it does | Gap against the contract |
|---|---|---|---|
| Brief `handoffs_to_me` | `src/core/tools.mjs:285-294` | Unsettled handoffs in the agent's last 200 log entries | Older handoffs drop out silently. No deadline. No coverage flag. |
| Settlement | `handoffSettlement`, `isDeclined` in `src/core/tools.mjs` | Accepted, or feedback with `declined: true`, settles the origin trail | Sound. Reuse it. |
| Person handoffs | `createBlocker` in `src/core/blockers.mjs` | A durable record per trail, with CAS updates | Agent handoffs have no durable record. |
| Daily check | `scripts/dogfood-check.mjs`, `api/cron/dogfood-check.mjs` | 7-day lookback, counts unanswered after 24h, writes one `stuck` entry each | The lookback hides older items. It counts, it does not list. |
| Audit page | `public/app/views.js:168`, `api/scorecard.mjs` | Daily scorecard history only | No pending rows, no Nudge, no coverage. |
| Nudge | `vercel.json:29` routes `/api/nudge` to `/api/work?op=nudge` (`api/work.mjs:75`), which calls `nudge()` in `src/http/work.mjs:83` | A person pings a job's owner | Needs a job. No item, no dedupe, no cooldown. |
| Huddle view | `huddleView` in `src/http/view.mjs:263` | Participants from @mentions plus repliers | Mentions become obligations, which the contract forbids. |
| Roundtables | none | Only legacy ACMI kinds such as `roundtable-open` | No LogMem model. |
| Sync tool | none | | No `logmem_sync`. The skills only say "read your Brief". |
| Reconciler report | PR #106, `lm:{space}:reconcile:report` | Cron writes a report the app reads | Same pattern fits the pending report. |

No open branch or PR conflicts. The `logmem-main` checkout holds other agents' uncommitted skill edits, so all work happens in separate worktrees.

## 3. Approach

### 3.1 One pending source, one item per recipient

An item is one obligation owed by one recipient: a handoff, one seat at a huddle or roundtable, or one recipient of a directed request. A huddle to three agents is three items.

- **Item ID.** `ci_` plus the first 24 hex characters of SHA-256 over `space|type|request trail|recipient`. It is stable: the same request and recipient always give the same ID, so a retry never makes a second item.
- **Record.** `lm:{space}:coord:item:{id}`. Fields: id, type, request trail, from, to, where, summary, expects, created_at, deadline (created_at + 86,400,000), response (open, answered, declined), disposition, settled_by, settled_at, settlement trail, next_action, last_nudge_at.
- **Indexes.** `lm:{space}:coord:open` (ZSET, score = deadline), `lm:{space}:coord:open:{agent}` per recipient, and `lm:{space}:coord:trail:{trail}` (SET of item IDs) to find the seats of one request.
- **Writes.** `logmem_handoff` writes its one item and the indexes in one EVAL with the entry. A note with `to` (section 3.2) writes one item per recipient the same way. The deadline is set once and never written again.
- **Settlement.** One CAS per item: it settles only an open item, only for its recipient, only in its space. A settled item never changes again.
- **What answers.** For a handoff, `logmem_accept` (accept or decline) as today. For a seat or directed request, a note that names the item with `answers: <item id>` and a disposition: `answered`, `declined` or `blocked`. A note with only an `origin`, a status line or an unrelated note does not settle anything. `blocked` answers the request and keeps its `next_action` visible as unfinished work.
- **Backfill.** `scripts/coord-backfill.mjs` scans every agent, job and channel log with a stored cursor. It is resumable. Until a scan completes, every reader reports `coverage: partial`.
- **Readers.** The Brief, the Audit page, the daily check and `logmem_sync` all read the index. The Brief falls back to today's log scan with `coverage: partial` when the index is missing.
- **ACMI acknowledgements.** A validated adapter may settle an item from an ACMI `handoff-ack`. It needs the item's space, the item's trail as `parentCorrelationId`, the item's recipient as the actor, an ack kind, and a timestamp after the item's creation and not in the future. A row that fails any check, including copied, forged, cross-space or wrong-recipient rows, shows as unverified evidence and leaves the item open. Accept and decline mean the same thing in every reader.
- Pure reads stay write-free. Only handoff, accept, answering notes, nudge and receipts write.

### 3.2 Huddles, roundtables and directed requests

- Obligations come only from an explicit recipient list. Add optional `to: [agents]` to `logmem_note` for kinds `huddle` and `memo`. A note with `to` creates one item per recipient (3.1).
- @mentions with no `to` stay visible in a "recipient unclear" list. They create no obligation. `@fleet` never does.
- Each recipient answers their own item (3.1). One reply settles one seat. The other seats stay open.
- Roundtables: a huddle with `to` plus `roundtable: true`. Only the author, or an agent the author names in `closer`, closes it, with a `done` entry that lists actions with owners. Missing seats keep it open.

### 3.3 `logmem_sync`: runs, slots and concurrency

The server cannot answer for an agent. Sync is a read tool plus a receipt.

1. `logmem_sync {}` (read only): returns the agent's open items with deadlines, overdue flags, linked replies since creation, and coverage. It starts no shift and writes nothing.
2. The agent answers with the tools it already has: `logmem_accept`, an answering note (3.1), `logmem_update`.
3. `logmem_sync { "receipt": true, "run_id": "<stable id>", "slot": "morning" | "midday" | "closeout" | "manual" }` writes one receipt for that run.

**A run is not a slot.**

- **Run.** Each logical run has a stable `run_id`, chosen by the runner or minted by the server and returned. Its attempt record is `lm:{space}:sync:run:{agent}:{run_id}` and never changes after it completes. A retry with the same `run_id` returns that run's receipt. A new manual sync gets a new `run_id` and sees current work.
- **Slot.** The slot record `lm:{space}:sync:slot:{agent}:{local date}:{slot}` lists every attempt in that slot and its verified outcome. A recovery after a failure is added to the list. It does not erase the failure or a missed deadline. An attempt counts for a slot only if it started inside that slot's window, so a missed morning cannot turn into a pass at closeout. A trigger or start without a verified receipt never passes a slot.
- **Crash recovery.** The run record goes `claimed`, then `complete`. A retry that finds `claimed` re-reads current state and finishes the receipt, marked `recovered`. A bare claim is never success. The slot view counts only `complete` attempts.

**Concurrency.** Agent tools cannot share a lease, so the contract does not promise one lock over a whole run. Instead:

- **Settlements.** Each settlement is one CAS on its item (3.1), so two runs cannot both settle one item, and a stale run cannot change a settled item.
- **Replies.** Each answering note carries an `action_id`, the hash of run, item and disposition. `SET NX lm:{space}:coord:action:{action_id}` refuses a second write of the same action.
- **Receipt phase only.** A lease with an owner token, a 120-second TTL and compare-and-delete release. A runner whose lease expired cannot complete the run record, so it cannot overwrite a newer run's receipt.

The `logmem` skill gets a "Sync" section, so clients without the tool follow the same steps.

The receipt reuses codex's fix for the recap counter (writes counted across agent, job and channel logs, mirrors removed, bound to actor and shift). There is no second counter. Until that fix lands, receipts are marked `partial`.

### 3.4 Audit page and Nudge

- `GET /api/view?what=audit` returns `pending` (cursor paged, filters for recipient, plan, type and overdue), `coverage`, `slots` (three-run state per roster agent, with Ops' exceptions) and `history` (the scorecard as today).
- The page leads with unanswered handoffs sorted by how overdue they are, then seats, then directed requests, then slot coverage, then data errors (future timestamps, missing stages, partial reads), then history.
- **Nudge reuses the existing route.** `/api/nudge` already maps to `/api/work?op=nudge`. That handler takes exactly one target:
  - `{ space, job, agent?, note? }`: today's job nudge, unchanged. It pings the job's owner and never picks a pending handoff.
  - `{ space, item, request_id, note? }`: an item nudge. The server loads the item and resolves the recipient and source from it. It never reads a recipient from the body.
  - A body with both targets, or neither, gets 400. A `trail` alone is accepted only if it names exactly one item, otherwise 409 with the item IDs.
- Both paths use the same authorization (a signed-in person with write access), the same request-intent checks and the same write helper.
- One EVAL claims the `request_id`, checks the one-hour cooldown for that item and re-checks settlement. A settled item returns its settlement and writes nothing. The cooldown applies per item, not per parent trail.
- The ping goes to the item's log (job or channel) and the recipient's log, with the item ID, trail and person. It never settles, transfers, reopens or moves a deadline.

### 3.5 Three runs

- Ops owns the central coverage inventory and the exception list. Each operator supplies the host, runner capability, missing access and any requested exception. Codex checks the evidence and the final coverage report.
- An exception names its accountable operator, reason and review date. Retirement is never inferred from silence. A person approves any permanent exclusion or retirement.
- The product side gives Ops the `slots` view. Per agent and local date, each slot shows its attempts and a state: pass (verified receipt), partial, failed, missed, disabled, blocked, unknown or exception. Unsupported and unscheduled agents stay visible.

## 4. Changes to the contract (accepted by codex)

1. **The server never answers.** Step 4 of the sync sequence ("answer each actionable item") is the agent's own tool calls. `logmem_sync` reads and records. This keeps "no impersonation" true by construction.
2. **Explicit recipients, new field.** Directed requests and huddle seats need `to` on the note. Without it there is no obligation (the contract's broadcast rule). Today's huddle view treats mentions as seats, and changes in PR C.
3. **Roundtables reuse huddles.** A roundtable is a huddle with `to`, `roundtable: true` and a named closer. There is no new entry kind.
4. **Backfill reports coverage.** Until the scan of a space completes, every reader says `partial`. No reader ever shows a clear result before that.
5. **Future timestamps are real today.** The agent-coordination feed has an entry with ts 17841395696220 (year 2535) pinned at the top. PR B flags such rows and sorts them out of the current view. It deletes nothing.

## 5. Delivery

PR A defines item identity before anything uses it. Order: A, then C, then B, then D.

| Order | PR | Scope | Cases |
|---|---|---|---|
| 1 | A | Item IDs and records, indexes, handoff and accept writes with CAS, the ACMI adapter, backfill with cursor and coverage, Brief and daily check read the index | 1, 3-10, 35 |
| 2 | C | `to` on notes, one item per seat, answering notes with `answers` and disposition, roundtable close, huddle view reads seats | 15-17, 28 |
| 3 | B | Audit sections, cursor paging, filters, item Nudge on the existing route with claim and cooldown, future-timestamp flags | 2, 11-14, 26, 34 |
| 4 | D | `logmem_sync` read and receipt, runs and slots, crash recovery, action IDs, receipt lease, slots view, skill Sync section | 18-25, 27, 29-33 |

All 35 cases map to exactly one PR. Each PR goes to codex for review. Merge, deployment, live backfill and schedule activation wait on Mikey's GO. GitHub Actions is still locked, so CI runs locally.

### Acceptance probes added by codex

| Case | Probe | Required result |
|---|---|---|
| 28 | Two huddle recipients | One reply closes one seat and leaves the other pending |
| 29 | Two manual syncs on one day | Each new run observes current state |
| 30 | Retry one run ID | Exactly one logical receipt appears |
| 31 | Partial attempt then recovery | Both attempts remain visible and current slot state reflects verified recovery |
| 32 | Crash after claiming a receipt | Retry finishes safely without false success |
| 33 | Expired run lease | The old runner cannot settle newer work |
| 34 | Nudge route compatibility | Both job-card and item-target requests reach the intended handler |
| 35 | Legacy wrong actor or copied trail | The original obligation remains pending |

## 6. Owned files

- PR A: `src/core/coord.mjs` (new), `src/core/tools.mjs` (handoff, accept, brief), `scripts/coord-backfill.mjs` (new), `scripts/dogfood-check.mjs`, `test/coord-*.test.mjs` (new)
- PR C: `src/core/tools.mjs` (note `to`, `answers`), `src/http/view.mjs` (huddleView)
- PR B: `src/http/view.mjs` (audit), `api/work.mjs` and `src/http/work.mjs` (item nudge), `public/app/views.js`, `public/app/actions.js`, `e2e/app.spec.mjs`
- PR D: `src/core/tools.mjs` (`logmem_sync`), `src/core/sync.mjs` (new), `skills/logmem/SKILL.md`, `docs/spec/tools.schema.json`

Codex owns the recap counter fix. Claude does not build a competing one.

## 7. Questions answered by codex

1. **Design location.** Codex's design and review are copied unchanged into this folder. The scratch sources stay as evidence.
2. **Recap defect.** Codex owns the fix as a separate change. PR D consumes it and marks receipts partial until it lands.
3. **ACMI acknowledgements.** A validated adapter, as in 3.1. A raw row with a matching parent trail is not enough.
4. **Exceptions.** Ops owns the inventory and exception list, as in 3.5.
