# LogMem dashboard UX

Status: Direction approved in the October 23 walkthrough. Written specification awaits user review.
Owner: Codex.
Parent job: `fleet-coordination-audit-p0`.
Source baseline: production main `dcef3b8`.

## 1. Outcome

Home helps an operator decide what needs attention and see the next step.
Every action preserves its source, authorized actor, and result.
The dashboard remains useful for solo operators, developers, managers, and small business teams.

The user approved these directions:

- An action-focused Home with a short brief and source links.
- Decisions first, then agent waits, recent changes, and current priorities.
- Primary navigation: Today, Work, Agents, and Activity.
- Administrative controls under Settings.
- Decision review with the exact action, evidence, and a separate execution receipt.
- Handoffs with original rolling deadlines and named recipients.
- Request a run for controlled agents, within budget and permission limits.
- A prioritized work list by default, with a board toggle.

The walkthroughs used synthetic business examples.
Their prices, deadlines, run receipts, and budget limits do not describe current production state.
This document authorizes no provider spending, schedule changes, or production rollout.

## 2. Problems observed

The existing Home gives plans, blockers, and agent cards equal visual weight.
It offers little guidance on what the person should do first.
Plans, lanes, and jobs overlap in navigation.
A connection can show Live while every agent appears inactive.
External blockers offer Unblock without enough visible context.
The sample workspace shows Live space.
The sample Needs you panel returned sign in required while Home remained visible.

The fleet sync also found unanswered obligations and incomplete coverage.
A recent activity page cannot establish the full pending backlog.
A deployment does not prove each local connector loaded the new code.

## 3. Information architecture

| Destination | Main question | Content |
| --- | --- | --- |
| Today | What needs my attention? | Brief, decisions, waits, recent changes, priorities |
| Work | Who owns the next step? | Prioritized list, board toggle, plan and milestone detail |
| Agents | Can this agent act? | Current task, reports, capabilities, run receipts, limits |
| Activity | What changed, and what proves it? | Grouped work updates and full source events |
| Settings | How is this space managed? | Connections, agent keys, administration, billing visibility |

Keep existing plan, track, milestone, and job storage primitives.
Use Work as the common navigation entry.
The Work screen can filter by plan and open its milestone detail.
Do not create another project entity solely for navigation.

Keep human coordination Audit accessible through Today and Agents.
Settings retains historical audit administration.
Required-response backlogs must remain easy to discover.

Preserve existing deep links through route aliases.
An old job or decision link opens the corresponding new detail panel.
On phones, use four bottom tabs and an account menu for Settings.

## 4. Today

The reading order is:

1. Short brief.
2. Needs your decision.
3. Waiting on your team.
4. Since your last visit.
5. Current priorities.

The brief names the current workspace and its main unresolved work.
Every statement links to source entries.
Show its update time, coverage, and missing information.
Start with deterministic summaries from trusted structured records.
No automatic paid summarization belongs in the initial release.

Decision cards show the question, requester, relevant work, deadline, and primary review action.
Tasks for people appear nearby, clearly labeled as tasks.
Agent waits show sender, recipient, expected result, original deadline, and last follow-up.
External waits show the accountable owner and next check.
Do not present an external wait as an unanswered agent request.

Show priorities as compact summaries.
Detailed plans remain one click away.
Keep administrative controls out of the daily work area.

An empty state requires a successful, complete read.
Partial reads show observed items and a visible coverage notice.
Use “At least N observed” when a partial count is useful.
Never turn a failed read into zero pending work.

## 5. Decision review

Open a wide panel beside the queue on desktop.
Use a full screen on phones.
The same decision panel opens from Today, Work, Activity, or a direct link.

Show:

- Exact proposed action.
- Requester and intended human decision maker.
- Destination, including the actual recipient address when relevant.
- Amount, scope, and changed fields when relevant.
- Full message, attachment, or operation preview.
- Source evidence and its version.
- Effect of approval and whether the action can be undone.
- Original request time and applicable deadline.

Production previews must not replace an exact destination with a vague contact label.
Missing mandatory fields prevent approval and explain what the requester must supply.

Actions are Approve, Request changes, and Decide later.
Approve binds the existing decision identity and action version.
A changed action requires a fresh decision.
Concurrent or stale submissions refresh the panel with the authoritative result.
Do not show success before the server confirms the saved decision.

Request changes requires a reason.
Use the current reject verdict with that reason.
The requester creates a revised ask through existing rules.
Do not introduce an unsupported decision verdict.

Decide later uses the existing defer behavior.
It remains open and retains its original age.
It does not silently create a new deadline.

After approval, show “Decision saved. Waiting for the agent.”
Track acknowledgement and completed execution as separate evidence.
Approval never means the email was sent or the operation succeeded.
Missing execution integration shows “Completion not verified.”
Do not invent a new receipt from a generic progress note.

## 6. Handoffs, huddles, and closeout

Reuse the merged coordination contract and its revision 2 amendments.
Claude retains the existing pending-index implementation assignment.
This design must not create a competing queue or backfill.

One obligation identifies space, canonical request, type, and recipient.
Preserve the original trail for replies.
Each recipient settles only their own obligation.

An unanswered handoff becomes overdue exactly 24 hours after its original creation time.
Nudges, starts, recaps, owner refreshes, and daily boundaries do not reset that clock.
Show the exact deadline in the viewer's timezone.
Store and compare timestamps in UTC.

Acceptance or decline settles the unanswered request.
Accepted work moves into progress.
Delivery and work closure remain separate.
A work due date must not replace the handoff response deadline.

Nudge adds one linked follow-up.
It does not settle, transfer, reopen, or restart the request.
Resolve the recipient on the server from the canonical item.
Reuse `/api/work?op=nudge` and the existing authorization path.
Keep job nudges distinct from coordination-item nudges.
Apply request deduplication and the existing one-hour cooldown contract.
Show the last nudge and next allowed follow-up.

A saved nudge does not prove delivery or wake an agent.
Explain that the recipient sees it during a later supported sync.
Request a run is a distinct action.

Reassignment preserves history.
An authorized person can cancel the old obligation with a reassigned disposition.
This does not forge acceptance or decline by its original recipient.
It creates a linked obligation for the new recipient with its own original timestamp.
The old overdue period remains visible.
Do not silently restart the old obligation's clock.
This disposition extends the coordination contract and requires a reviewed implementation.
Keep reassignment unavailable while the canonical model cannot preserve this distinction.

Huddles show required respondents and unresolved actions.
Roundtables show the named closer and linked synthesis.
A broadcast mention alone does not create obligations.
Only an authorized closer settles the roundtable.
Pending-index coverage and backfill state remain visible.

## 7. Work

Default to a prioritized list.
Keep a board toggle and remember that preference per space.

Prioritize human decisions, overdue responses, blocked work, active work, then open work.
Sort ties by relevant deadline and stable identity.
Show completed work in a separate section.
Do not hide missing owners or unknown stages.

Each row shows title, owner, status, next step, and relevant due time.
Distinguish the overall job owner from a handoff recipient.
A row opens one shared work detail panel.
That panel holds goal, plan, milestone, decisions, handoffs, evidence, and history.

Filters cover plan, owner, status, and attention type.
Keep search and selected filters across refreshes.
A displayed completion percentage includes its denominator.
Exclude milestones from ordinary job totals.
Explain parked, excluded, or unread items when they affect the number.

## 8. Agents

Use distinct labels for:

- Connection health.
- Last agent report.
- Current task.
- Runner capability.
- Actual run state.
- Schedule coverage.

Recent activity alone does not prove the agent is running.
No recent report alone does not prove the agent is offline.
Show unknown states plainly.

Each agent has three daily slot records.
Use the existing proposed times: 09:00, 13:00, and 17:30 America/New_York, including weekends.
An authorized configuration can select another timezone or schedule.
Compute local dates and daylight saving changes correctly.

Every slot shows scheduled time, attempt receipts, outcome, and coverage.
Each run checks handoffs, huddles, roundtables, and directed requests.
The final slot includes explicit closeout and unresolved carryover.
A trigger without a verified receipt does not satisfy the slot.
A manual run does not satisfy a scheduled slot unless that slot's verified recovery rules explicitly attach it.
Earlier failures remain visible after recovery.

Ops retains host, scheduler, and rollout ownership.
Reuse existing schedules before proposing additions.
Unavailable clients show Unsupported or Unverified coverage.
Do not claim fleet-wide compliance from one local registry.

## 9. Request a run

This is a separate delivery phase with its own runner integration.
Show the action only where its supported capability is known.
Show an explanation and a reminder fallback when the action is unavailable.

Before admission, verify:

- Signed-in actor and permission for the selected space and agent.
- Canonical task or handoff scope.
- A registered runner that can receive the request.
- Current allowance and relevant provider limits.
- Enforceable resource and spending limits for that route.
- Concurrency and duplicate-request controls.
- Ability to return durable attempt and result receipts.

The configured limit comes from an authorized policy.
The mockup's $0.10 cap is illustrative and establishes no default spending authority.
Unknown billing routes, stale required snapshots, or unenforceable required limits prevent admission.
A cost estimate is not a hard cap.

Reserve shared allowances atomically before dispatch.
A browser retry returns the original request receipt.
Do not dispatch another paid run after an ambiguous network response.
Bound retries and delegated activity within the same policy.
A child run cannot bypass the parent's limits.
Reconcile unused reservations through durable completion or expiry rules.

The initial request scopes one run to one selected obligation.
It grants no permission to send customer messages, publish, delete, or spend outside existing approved limits.
The agent still follows the job's human decision rules.

Return Queued only after durable queue admission.
Return Running only after a runner receipt.
Return Succeeded only after supported execution evidence.
Keep Failed and Unknown distinct.
A missing receipt is not success.

Pausing future runs requires verified host control and records a separate receipt.
It does not imply an active run stopped.
If controls are unavailable, disable the action and explain the gap.
Do not add an apparent shutdown button without enforcement.

## 10. Activity

Default to meaningful work updates.
Group related events under the work and canonical request they changed.
Show the actor, local time, actual outcome, and evidence link.

Deduplicate mirrored copies using canonical identity.
Keep distinct replies and attempts.
Retain full events under All events.
Automatic starts and connection checks remain available there.

Do not infer a decision or handoff settlement from generic prose.
Future timestamps appear as data errors without pinning the current feed.
Preserve the source record.

## 11. Architecture and existing work

Retain the current lit-html app and existing design system.
Reuse `public/ds/tokens/logmem.css`, component styles, fonts, and logo assets.

| Area | Existing paths or owner | Change boundary |
| --- | --- | --- |
| Navigation | `public/app/shell.js` | Today, Work, Agents, Activity, Settings |
| Views | `public/app/views.js` | New hierarchy and truthful empty states |
| Shared items | `public/app/cards.js`, `drawer.js` | Decision, wait, and work detail |
| Actions | `public/app/actions.js` | Existing decisions and nudge semantics |
| State and time | `public/app/core.js` | Coverage, freshness, local deadlines |
| Read models | `src/http/view.mjs` | Explicit coverage and source identity |
| Coordination | Claude's existing PR A assignment | Pending index, backfill, atomic settlement |
| Schedule inventory | Ops existing job | Host and three-slot receipts |
| Run integration | Separate capability and admission design | No speculative dispatch endpoint in UI phase |

Use one authoritative pending source across Today, Audit, Brief, and sync.
Keep API shapes explicit and preserve existing routes.
Add fields compatibly where possible.

The P0 parent remains with Codex.
Hermes retains billing reconciliation.
No new dashboard register replaces the canonical billing register.
A local connector's adoption remains independently verifiable from hosted deployment state.

## 12. Errors, accessibility, and responsiveness

Distinguish authentication failure, missing permission, storage failure, and partial coverage.
Preserve a typed note after refresh or a refused action.
Offer retry without losing the selected item.
Keep settled items visible long enough to explain the authoritative outcome.

Explain sample environments consistently.
The five seeded spaces must never say Live space.
Their review paths must either work with isolated sample handlers or clearly explain their unavailable capability.

Keep panel focus trapped and restore it on close.
Support Escape, keyboard navigation, visible focus, and screen-reader action results.
Use at least 44-pixel tap targets.
Do not encode state through color alone.
Honor reduced motion and existing theme support.
Use full-screen details on phones.
Preserve scroll, selection, and notes during live updates.

Connection freshness must not imply complete data coverage.
Show the last successful read and an explicit degraded state.

## 13. Acceptance checks

| Case | Required outcome |
| --- | --- |
| First visit | Person can identify their next decision and its source |
| Partial Today read | Coverage notice; no false zero or all-clear |
| Missing destination | Approval unavailable with a precise reason |
| Changed decision version | Stale approval refused; latest action displayed |
| Duplicate approval | One authoritative outcome and receipt |
| Request changes | Reject with required reason; revised ask remains separate |
| Decide later | Original request and age remain visible |
| Approved but no execution proof | Pending completion, not success |
| 25-hour unanswered handoff | Overdue from original creation time |
| Nudge and retry | One follow-up; original deadline unchanged |
| Acceptance | Pending response settled; work remains active |
| Reassignment | Linked new obligation; old overdue history retained |
| Missing huddle respondent | Unresolved seat remains visible |
| Roundtable participant reply | Other seats and synthesis remain open |
| Scheduled trigger only | Slot remains unverified |
| Manual run | Does not conceal a missed daily slot |
| Unknown required budget control | Run request disabled with a useful fallback |
| Concurrent run admission | Shared limit cannot be exceeded by racing requests |
| Ambiguous dispatch response | No duplicate paid run |
| Unsupported remote client | No false Run now or Stop control |
| Late execution receipt | State reconciles to evidence without erasing attempts |
| Future timestamp | Error visible; current updates remain readable |
| Sample Needs you | Working isolated flow or honest capability message |
| Phone and keyboard | Entire review flow works without lost context |

Use behavioral tests for state, authorization, races, and failure recovery.
Use browser walkthroughs at 390, 768, and 1280 pixels.
Use synthetic fixtures and isolated storage.
A browser screenshot alone does not prove runtime dispatch or budget enforcement.

## 14. Delivery sequence

### A. Dashboard foundation

Change navigation, Today hierarchy, work list, and shared details.
Keep source-backed briefs deterministic.
Fix the sample review path and environment labels.
Ship only truthful current capabilities.

### B. Coordination views

Integrate Claude's pending index after review.
Add unanswered obligations, coverage, nudges, huddles, and schedule receipts.
Verify the existing coordination contract's acceptance cases.
Do not duplicate PR A.

### C. Runner controls

Define the adapter contract and policy enforcement before enabling Request a run.
Validate at least one actual runner through its admission and result receipts.
Keep unsupported routes unavailable.
Ops and Hermes supply host and billing evidence.

### D. Final acceptance

Verify the joined flow from Today through decision, handoff, execution, and evidence.
Recheck mobile, accessibility, partial reads, and stale state.
Review the written implementation plan before changing production.
Keep these phases separately reviewable.

## 15. Scope boundaries

This design does not promise universal agent control.
It does not add a chat platform or automatic paid summaries.
It does not replace existing memory, decision, or coordination primitives.
It does not close the P0 parent until runtime and schedule evidence satisfies its criteria.

The next step is user review of this specification.
After that review, prepare the implementation plan.
