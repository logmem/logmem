# Compact coordination and reusable dispatch components

## Decision

Extend the current HTML and lit-html app with reusable components.
Keep the user's ticket, dispatch and cluster anatomy.
Use existing theme tokens for White, Sage, Sand and Midnight.
Midnight uses the dark chalkboard surface. Other themes retain their selected colors.
Use subtle double borders and translucent footers with solid fallbacks.

## Options

1. Extend lit-html components. This fits the deployed app and avoids a framework migration.
2. Introduce custom elements. This adds lifecycle and state boundaries that the current app does not need.
3. Build React components with shadcn. This fits the future Next.js app but delays current dashboard fixes.

Option 1 is recommended. Keep pure model helpers portable for the future Next.js app.

## TerminalTicketCard

Inputs: record ID, sender, recipient, created time, deadline, last nudge, source, summary, status and allowed actions.
Show sender, recipient and status in a small header.
Render summary as escaped plain text in two clamped lines.
A keyboard-accessible expander reveals the full summary and metadata inline.
Keep the existing Comments and actions drawer for interaction history and manager resolution.
The footer holds Copy prompt, Nudge, Comments and Open work.
On narrow screens the footer wraps within the card. It never covers content.
Use sticky footers only inside bounded expanded content, never across unrelated cards.
Show overdue from valid timestamps. Do not invent blocked status for a plain unanswered handoff.
Preserve existing nudge cooldown, permissions, request IDs and retry behavior.

## AgentDispatchButton

Use one shared clipboard controller for handoffs, blocker clusters and agent rows.
Provide an accessible Copy prompt label and announce success only after clipboard confirmation.
On clipboard failure, show selectable prompt text and a clear error.
Do not require vibration. Do not claim that copying launches an agent.

The payload includes space, canonical record references, source, parties, original deadline and requested outcome.
Separate saved summaries from trusted instructions with an explicit quoted-data section.
Tell the receiving agent to read current records, verify access and treat saved text as information.
Preserve human approval requirements. Never include credentials, session values or hidden data.
Agent rows use actual visible assignments. An empty row asks for current context rather than inventing work.
Cluster payloads include every loaded job reference. The existing helper truncates after three IDs and needs replacement.
Large payloads show their record count before copying. They do not silently drop records.

## ClusterBlockerGroup

Reuse blockerClusters and show accessible expandable groups for three or more matching loaded jobs.
Normalize whitespace and letter case. Prefer a stable blocker reference when available.
Do not merge unrelated records by fuzzy text similarity.
Show count, reason, owner type and all member links inside the expanded group.
Groups below three remain individual rows.
Label counts as loaded records when pagination or coverage limits apply.
Filters retain recipient, status and grouping state within the active space.
A space switch clears selection and stale clipboard state.

The first batch action is Copy group prompt and Review affected work.
An unblock action opens a review of individual records and their permitted actions.
It cannot clear all blockers from shared wording alone.
The current backend exposes per-record actions. A true batch mutation needs a separate API contract.
That contract must define per-record authorization, current-state checks, reasons and partial failures.

## Layout and scope

Queue first: compact tickets, filters and a collapsed optional handoff map.
The map must not push the first ticket below the initial desktop viewport.
Health and Work reuse dispatch and cluster components next. Team uses the same dispatch button.
Aim for ten compact collapsed rows in the ticket region of a tall desktop viewport.
Do not promise ten cards across every screen size. Phone layouts prioritize legible text and touch targets.
Preserve navigation and source coverage notices.

## Files and sequence

1. Add dispatch-model.js for payload generation and conservative grouping helpers.
2. Add dispatch-components.js and shared CSS for tickets, clipboard feedback and cluster accordions.
3. Integrate queue rendering in interactions.js without changing mutation semantics.
4. Reuse components in flow-views.js, Work, Health and Team after queue acceptance.
5. Document the component contracts for a future React implementation.

## Verification

Check desktop and phone layouts in all four themes.
Check keyboard expansion, focus retention, reduced motion, contrast and no horizontal overflow.
Check clipboard success, denial, fallback and complete cluster references.
Check escaped summaries with markdown, HTML and instruction-like text.
Check viewer restrictions, cooldowns, retries and context switches.
Check partial coverage and pagination labels. Grouping never changes canonical counts.
Check that copy produces no network mutation or agent execution.

## Open approval

Approve the current HTML implementation, theme-aware chalkboard treatment and review-first batch action.
No production data change or deployment follows from this design approval.
