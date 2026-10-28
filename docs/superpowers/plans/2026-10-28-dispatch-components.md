# Dispatch Components Implementation Plan

**Goal:** Make coordination records compact, readable and easy to dispatch.
**Architecture:** Pure payload helpers feed reusable lit-html templates. Existing controllers retain writes and permissions.
**Tech Stack:** JavaScript, lit-html, CSS, Node tests and Playwright.
**Spec:** docs/superpowers/specs/2026-10-28-dispatch-components-design.md

## Constraints

Preserve four themes, literal data rendering, per-record authorization and canonical counts.
Copying starts no agent. Grouping does not authorize batch mutation.

## Review focus

Clipboard denial must show selectable text. All cluster IDs must survive copying.
Pagination counts must describe loaded records. Space switches must clear transient controls.
Nudge retries and literal hostile summaries must remain safe.

## Tasks

- [x] Add pure dispatch-model helpers and tests for payloads, grouping and invalid dates.
- [x] Add lit-html ticket, dispatch and cluster components with theme-aware CSS.
- [x] Integrate queue status filters and collapsed optional map. Preserve existing nudge controller.
- [x] Reuse dispatch buttons for Team and blocker groups for Work and Health.
- [x] Verify clipboard fallback, keyboard behavior, themes, phone layout and mutation restrictions.
- [x] Run repository checks, review diff and commit the candidate.

## Verification

All 987 repository tests pass. Schema checks pass.
34 initial browser cases passed for queue controls, shell and existing interactions.
20 final browser cases passed for dispatch, grouping and Health on desktop and phone.
The browser cases cover four themes, literal text, clipboard denial and no copy mutations.
An initial repository check caught a missing module header comment. The corrected suite passes.
Screenshot review led to tighter queue spacing and a collapsed map.
No backend mutation or batch unblock endpoint changed.

## Component contracts

`terminalTicketCard({item,space,actions,notice,now})` renders a literal record with caller-owned actions.
`agentDispatchButton(prompt,label)` owns clipboard feedback and selectable failure text.
`clusterBlockerGroup(cluster,space)` renders affected job links and a complete review prompt.
Pure text and grouping helpers live in dispatch-model.js and can support a future React view.
