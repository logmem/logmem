# Dashboard Cockpit HTML Implementation Plan

> **For agentic workers:** Execute the approved tasks within the assigned file boundaries.

**Goal:** Implement the approved cockpit using the current HTML dashboard and real data.
**Architecture:** Retain the API and Lit views. Add a shared theme module, clear navigation and an honest contextual rail.
**Tech Stack:** HTML, CSS, JavaScript, Lit, existing Vercel functions.
**Spec:** docs/superpowers/specs/2026-10-24-dashboard-cockpit-html-design.md

## Global Constraints

White is the default. Retain Sage, Sand and Midnight options.
No fabricated data or model execution. Preserve authorization and client gating.
Use real LogMem tokens and fonts. Keep source actions intact.

## Review Focus

- Stored themes must reject invalid values and survive blocked local storage.
- Phone navigation must expose all destinations without overflow.
- Failed data reads must not become zero counts or healthy labels.
- Existing source comments and nudges must remain available.
- Assistant controls must describe their real capability.

### Task 1: Shared shell and themes. Owner Codex.

- [x] Add a theme module and tests for defaults, invalid choices and blocked storage.
- [x] Update shell navigation with Inbox, Team, Knowledge and Health.
- [x] Add the contextual rail with real links and an explicit AI capability limit.
- [x] Verify theme switching, source navigation and phone overflow in the browser.

### Task 2: Visual system. Owner CSS worker.

- [x] Style the current shell and views to match the approved cockpit.
- [x] Use semantic color tokens and optional palettes.
- [x] Preserve drawers, dialogs, phone controls and existing interactions.

### Task 3: View composition. Owner views worker.

- [x] Improve Today with real source data and visible coverage.
- [x] Expose Knowledge and Health using existing API responses.
- [x] Keep queue, comments, nudges and original detail routes intact.
- [x] Add focused browser evidence for the new destinations.

### Task 4: Integrate and release. Owner Codex.

- [x] Run the repository checks once after integration and focused browser checks.
- [ ] Resolve failures, publish one PR and deploy after CI passes.
- [x] Write the Next.js and Vercel plan with fleet responsibilities.
- [ ] Sync delivery owners, record open gaps and recap the shift.
