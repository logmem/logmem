<!-- Copied unchanged from codex's scratch workspace on Oct 22, 2026 (job fleet-coordination-audit-p0). Author: codex. -->

# P0 fleet coordination closeout

Codex owns this P0. Sync closes coordination loops and gives humans evidence of unfinished work.

## Authority and scope

Michael requested this work on October 22, 2026.
He requires a useful audit page, human nudges, rolling handoff deadlines, and three scheduled runs per agent.
He then required sync to close handoffs, huddles, roundtables, and coordination threads.
He asked Codex to coordinate with Claude.

Parent job: `fleet-coordination-audit-p0`.
Claude job: `coordination-sync-audit-design`.
Ops uses its existing job: `fleet-acmi-protocol-enforce-v1`.

This document records the requested behavior and the proposed implementation contract.
Claude must identify existing work before creating branches or changing files.
Codex retains product design, coordination, and acceptance.
Claude owns the product implementation after confirming the contract.
Ops owns schedule discovery and rollout evidence.
Each agent retains responsibility for its own responses and work.

## Baseline

The current Audit page renders daily scorecard totals.
It does not list pending handoffs across the fleet or attach a Nudge action to each handoff.
The agent detail page lists handoffs from a bounded log read.
The existing Nudge endpoint requires a job.
Channel handoffs also need a human nudge path.

The current huddle view derives participants from mentions and linked replies.
A broadcast mention alone does not define individual obligations.
The daily check uses a historical lookback and records overdue counts.
Old pending work must remain visible after that lookback expires.

The routine matrix uses weekday schedules and mixes daily loops with monitoring.
That matrix does not prove three daily runs for every agent.
The local Hermes registry contains 18 schedules at the current read.
Seven are enabled. Eleven are disabled.
These file values do not prove successful end-to-end coordination.

The main checkout contains other agents' skill edits. Preserve them.
No new `logmem_sync` tool appears in the current connected schema.
Claude must confirm the current CLI and skill command surface before adding one.

## Design choice

Extend the existing Audit view and coordination model.
Use the same pending-item source for Audit, Brief, sync, and scheduled checks.

An Audit-only change leaves failed schedules invisible.
A scheduler-only change leaves humans without item-level controls.
The joined design covers the response, its deadline, and the run that checks it.

Reuse canonical handoff and settlement logic.
Do not build a second queue from a recent activity sample.
Use durable pending indexes where supported.
Backfill older unresolved items through a resumable scan.
Expose incomplete coverage while backfill or reads remain incomplete.

## Sync contract

The user command is `logmem sync`, or the equivalent skill instruction on clients without that command.
Claude chooses the native tool surface after checking current work.

Every sync performs this sequence:

1. Load the current actor, space, Brief, owned work, and coordination subscriptions.
2. Enumerate unresolved handoffs, huddle invitations, roundtable responses, and directed coordination requests.
3. Follow their original trails and retrieve replies, changes, and relevant decisions.
4. Answer each actionable item through the existing authorized response mechanism.
5. Reconcile completed work only when its evidence satisfies the existing job criteria.
6. Record unresolved items with their owner, blocker, next action, and next check.
7. Update the actor's current work and write one linked sync receipt.
8. Read back settlements and pending items before reporting the result.

Keep one MCP session for start, work, and verification.
Do not create another shift for each read.
Read-only sync planning must not manufacture starts or work updates.

A sync receipt records these fields:

| Field | Meaning |
|---|---|
| Actor and space | The identity and authorized scope |
| Run ID and slot | Manual, morning, midday, or closeout |
| Started and finished | Actual execution times |
| Checked items | Counts by coordination type |
| Responses | Exact trails and verified outcomes |
| Pending items | Owner, deadline, blocker, and next action |
| Coverage | Sources read, skipped sources, and errors |
| Result | Clear, needs attention, partial, or failed |

A clear result requires complete reads and zero unanswered obligations.
A completed sync can still need attention.
Carryovers remain visible. They do not count as settled responses.
A read error or cap produces a partial result.
Never display an unread queue as empty.

## Closeout rules

| Item | Valid response | What stays open |
|---|---|---|
| Agent handoff | Recipient accepts or declines the original trail | Accepted work remains open until its criteria pass |
| Huddle invitation | Required participant writes a substantive reply linked to its trail | Missing participants and unresolved actions |
| Roundtable | Required participant responds, then the authorized convener records synthesis and actions | Unanswered participants and unassigned actions |
| Directed coordination request | Named owner answers with evidence or an explicit blocker and next action | Any resulting unfinished work |
| Human approval | The authorized person answers through the existing decision path | Agents cannot answer it during sync |
| Human task | The assigned person records the actual outcome | Agent health must not conceal the task |

Only the handoff recipient settles its response.
Do not turn a generic memo into an accepted handoff.
Use a linked memo or supported reply for huddle responses.
Do not write `accepted` through a generic note.

Only the convener or an explicitly delegated closer closes a roundtable.
A participant's sync cannot close other participants' obligations.
A summary without named actions does not close unresolved work.

Do not treat every coordination memo as a task.
New directed requests need explicit recipients and an expected response.
Keep legacy mentions visible for review when recipient intent is unclear.
Do not assign obligations from `@fleet` alone.

## Rolling handoff deadline

The response deadline equals the original handoff creation time plus 86,400,000 milliseconds.
Compute it separately for every handoff.
Store and compare times in UTC.
Display the viewer's timezone and the exact deadline.

At the deadline, an unanswered handoff becomes overdue.
Nudges, starts, recaps, daily boundaries, and owner refreshes never reset the deadline.
Parking a job does not excuse its recipient from answering a handoff.
A decline with a reason answers the handoff.
Acceptance answers the handoff but does not finish the task.

Deduplicate mirrored copies by canonical identity, including space and trail.
Use an immutable item ID where the storage model supports it.
New nudges or copied summaries must not hide the original item.
A settlement from another actor or space cannot clear it.

Unresolved items remain visible regardless of age.
Do not restrict the live backlog to the scorecard window.
Keep daily history separate from the current backlog.

## Human Audit page

Lead with pending coordination and schedule gaps.
Retain daily scorecard history below the actionable sections.

Show these sections:

1. Unanswered handoffs, sorted by overdue duration and deadline.
2. Huddles and roundtables with required responses still missing.
3. Directed coordination requests with unresolved owners or actions.
4. Three-run coverage for every roster agent.
5. Data errors, missing stages, future timestamps, and incomplete reads.
6. Daily audit history and mirror checks.

Each handoff row shows sender, recipient, summary, job or channel, creation time, exact deadline, age, and last nudge.
Add an Open action and a Nudge action.
Support filters for recipient, plan, coordination type, and overdue state.
Show counts computed from the complete pending source.
Use cursors for paging. Disclose partial results.

A Nudge writes one linked ping to the canonical work log and recipient log.
The server resolves the recipient from the canonical item.
It must not trust a replacement recipient in the browser payload.
Include the original trail and the human actor.
Support channel handoffs and legacy unfiled items without changing job ownership.
Show an inline explanation when the source cannot support a safe write.

Nudging must not settle the handoff, transfer work, reopen a job, or change its deadline.
Require a signed-in person with write access to the space.
Use existing request-intent and space checks.
Read-only people can inspect the item and see why Nudge is unavailable.

Use request IDs and an atomic claim to deduplicate repeated clicks and network retries.
Recheck settlement before writing.
If the recipient already answered, refresh the row and report that result.
If settlement races the ping, preserve the settlement and show the harmless ping once.

Rate-limit repeated nudges per item.
Show the last nudge, cooldown, and next allowed action.
Proposed cooldown: one hour.
Human nudges produce no new handoff and no owner transfer.

## Three daily runs

Every agent needs three daily coordination runs.
Use local labels: morning, midday, and closeout.
Proposed fleet times: 09:00, 13:00, and 17:30 in `America/New_York`.
Run them daily, including weekends.
Use the timezone identifier so daylight saving changes follow local time.
Stagger agents within their slots to avoid a burst.

Each run invokes the same sync contract.
All three runs read and answer handoffs, huddles, roundtables, and directed coordination requests.
Morning confirms the work and blockers.
Midday checks progress and new obligations.
Closeout resolves outstanding responses and records owned carryovers.

A slot passes only when its sync receipt verifies.
A scheduled trigger, heartbeat, or generic start entry does not pass the slot.
Show missed, failed, partial, disabled, blocked, or unknown states explicitly.
A retry keeps the same slot and uses a stable idempotency key.
A missed morning run cannot become a claimed success during closeout.

Keep monitoring and safety watchdogs where their roles remain distinct.
Reuse existing coordination runs before adding schedules.
Do not enable disabled jobs merely to reach a count.
Do not schedule retired identities without checking their status.
Every roster entry needs coverage or an explicit exception with an accountable owner.
Unsupported clients need a supported runner or a visible human action.

Respect existing execution authority and spend limits.
When a host lacks a runner, credentials, or access, show the gap.
Do not claim that a Codex reminder wakes every external fleet agent.

Use one execution lock per agent and space.
Queue work behind an active run.
Stagger slots and bound retries.
Catch up on a missed run without a burst of duplicate replies.

## Noise control

Write a linked response when an item changes or receives its required answer.
Write one compact receipt per scheduled slot for audit evidence.
Show no-change receipts in the audit detail, outside the default activity view.
Do not send a human notification for each quiet successful run.
Notify humans for a new actionable blocker, failed run, missed deadline, or completed gate.

Keep starts and repeated unchanged pings out of the default work timeline.
Preserve the underlying log entries.
Reject or flag invalid future timestamps without deleting historical evidence.
Do not let future rows pin the current activity view indefinitely.

## Ownership and delivery

| Owner | Responsibility | Boundary |
|---|---|---|
| Codex | Product design, coordination, acceptance review | Parent remains with Codex |
| Claude Code | Sync model, shared pending reader, Audit UI, Nudge integration | Confirm existing branches before editing |
| Ops Center | Scheduler inventory and coverage rollout | Reuse existing protocol job |
| Each agent | Actual responses and work evidence | No impersonation by the coordinator |

Claude must name any conflicting owner or existing branch first.
Keep source and test changes in an isolated checkout.
Preserve other agents' edits.
Do not hand the parent job to each collaborator.
Report designed, implemented, tested, scheduled, and live-verified states separately.

## Delivery sequence

1. Claude and Codex confirm the shared sync and settlement contract.
2. Ops maps every agent to its host, scheduler, existing routines, and missing access.
3. Claude adds the complete pending source and response references.
4. Claude adds Audit rows and human nudges with the existing authorization checks.
5. Claude wires sync to the same source and records verified receipts.
6. Ops maps three daily slots to supported runners and removes duplicate coverage.
7. Codex verifies behavior and reviews exact revisions.
8. Release follows the existing human approval path.

A written schedule is not a live schedule.
An accepted handoff is not implementation.
A successful test is not production verification.

## Acceptance tests

| Case | Required result |
|---|---|
| Handoff at 23:55 | It becomes overdue 24 hours later, not at the next midnight |
| Nudge at 23 hours | Original deadline stays unchanged |
| Exact 24-hour boundary | An unanswered item becomes overdue |
| Decline with reason | Response closes and the reason remains visible |
| Accept unfinished work | Response closes while the task stays open |
| Wrong actor or space | Settlement cannot clear the original obligation |
| Mirrored copies | One pending item appears |
| Old pending handoff | It remains visible beyond the daily audit lookback |
| More items than a page | Pagination retrieves every pending item |
| Read failure or scan cap | Result shows partial coverage and never all clear |
| Jobless channel handoff | Human can nudge its canonical recipient safely |
| Repeated Nudge click | One logical ping appears |
| Concurrent settlement | Nudge preserves settlement and reports current state |
| Read-only or cross-space person | Server refuses the write |
| Huddle reply | It links the original trail and updates only that participant |
| Participant missing | Roundtable remains unresolved |
| Broadcast with no explicit recipients | It creates no invented individual obligation |
| Human approval pending | Sync leaves the decision to the person |
| Concurrent sync runs | Only one run writes the same responses |
| Scheduled run without receipt | Slot does not pass |
| All three daily slots | Each checks every coordination category |
| Final slot with unresolved work | Receipt lists owners and next actions |
| Retry after partial writes | No duplicate settlement or receipt appears |
| Daylight saving change | Three local daily slots remain scheduled |
| Disabled or unsupported agent | Coverage gap remains visible |
| Future timestamp | Audit flags the row and current work stays visible |
| No-change slot | Audit receives evidence without a human alert |

## Review status

Codex completed the baseline and assigned Claude the joint design review.
Ops received the read-only schedule inventory request.
Claude acceptance and implementation evidence remain pending.
No product code, live schedules, deployment, or credential changes occurred in this design pass.

