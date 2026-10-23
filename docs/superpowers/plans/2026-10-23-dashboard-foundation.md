# Dashboard Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved dashboard foundation with truthful current capabilities.

**Architecture:** Extend the existing lit-html views and shared detail panels. Reuse current read models and decisions. Coordination indexes and runner dispatch remain separate integrations.

**Tech Stack:** Node.js, lit-html, native browser APIs, existing LogMem design tokens.

**Spec:** `docs/superpowers/specs/2026-10-23-logmem-dashboard-ux-design.md`

## Global Constraints

- Primary navigation: Today, Work, Agents, and Activity.
- Administrative controls under Settings.
- Keep existing deep links through route aliases.
- No automatic paid summarization belongs in the initial release.
- Never turn a failed read into zero pending work.
- Approval never means the email was sent or the operation succeeded.
- Preserve scroll, selection, and notes during live updates.
- Use at least 44-pixel tap targets.
- Store and compare timestamps in UTC.
- Keep unsupported runner actions unavailable.
- Preserve Claude's pending-index ownership and Ops schedule ownership.

## Review Focus

- Failed or incomplete reads must not claim an empty inbox.
- Sample reads must work without weakening production write authentication.
- Work sorting must preserve unknown stages, missing owners, and milestone boundaries.
- Stale decisions and unsuccessful submissions must preserve notes and avoid false completion.
- Space changes must not reuse another space's preferences, receipts, or late responses.

## Scope and implementation rulings

This plan implements delivery phase A only.
The approved design's phases B and C depend on existing owners and runtime evidence.
Expose those capability gaps clearly without fake data or dead Run now buttons.
The user approved execution with “yes go.”
Use native execution here and one fresh whole-branch reviewer.
No repeated approval prompt is needed before reversible implementation.

The existing checkout is isolated from the shared source.
Use branch `codex/dashboard-ux-design-20261023`.
Keep its dependency symlink untracked.
The baseline content equals production main `dcef3b8`; its full CI already passed 771 tests.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `src/http/view.mjs` | Home decision items, bounded job updates, explicit coverage |
| `api/work.mjs` | Read-only preview access consistent with /api/view |
| `public/app/dashboard-model.js` | Pure ordering, brief, environment, and decision validation helpers |
| `public/app/shell.js` | Four main destinations, admin disclosure, environment and connection labels |
| `public/app/views.js` | Today, prioritized Work, board toggle, Activity, truthful agent capabilities |
| `public/app/cards.js` | Decision context, clear action labels, honest agent last-report labels |
| `public/app/actions.js` | Required change reasons and saved-decision receipts |
| `public/app/core.js` | Space-scoped state and local time formatting |
| `public/app/main.js` | Read response handling and refresh behavior |
| `public/app.css` | Responsive Today, work list, receipt, and navigation styles |

### Task 1: Truthful dashboard data and safe sample reads

**Files:**
- Modify: `src/http/view.mjs`, `api/work.mjs`
- Create: `public/app/dashboard-model.js`
- Test: `test/dashboard-foundation.test.mjs`
- Reuse: `test/live-app.test.mjs`, `test/business-demos.test.mjs`

**Interfaces:**
- Consumes: `homeView(store, redis, space, options)`, `needsView(...)`, `mayRead(req, env)`.
- Produces: additive Home fields `needs_items`, `recent`, and `coverage`.
- `coverage` includes `complete: false`, scope notes, and observed read errors.
- Recent updates cover bounded job logs only. They are not the full coordination backlog.
- Export `prioritizeWork(jobs, now)`, `briefFor(home)`, `isSampleSpace(space)`, and `decisionProblem(ask, verdict, note)`.
- GET needs and pulse use mayRead. POST remains isAdmin plus intent and origin checks.

- [ ] Write behavioral tests before changing production code.
  - Seed five actual business spaces; Home returns the pending decision and source-linked job updates.
  - Fail one job read; coverage reports that source failure and never claims complete coverage.
  - GET needs works in password-free development, but production and configured-password preview require authentication.
  - Unauthenticated POST remains refused in development and production.
  - Pure ordering keeps milestones out, human attention first, then blocked, active, open, and done.
  - Unknown stages and missing owners remain visible. Stable ties use job ID.
  - Missing exact action prevents approval; change requests need a reason.
  - Sample detection includes all five seeded spaces.
- [ ] Run `node --test test/dashboard-foundation.test.mjs`.
  Expected: assertions fail because the new fields, preview read policy, and helpers are absent.
- [ ] Add bounded job-update reads with error collection to Home.
  Use existing needs results rather than recomputing their count independently.
  Keep observation limits explicit.
- [ ] Implement pure helpers and the GET-only read policy.
- [ ] Run `node --test test/dashboard-foundation.test.mjs test/live-app.test.mjs test/business-demos.test.mjs`.
  Expected: all pass.
- [ ] Commit the data and model changes.

### Task 2: Today, Work, navigation, and truthful status

**Files:**
- Modify: `public/app/views.js`, `shell.js`, `core.js`, `main.js`, `app.css`
- Modify: `public/app/cards.js`
- Test: `test/dashboard-foundation.test.mjs`
- Update existing route expectations only when approved labels changed.

**Interfaces:**
- Consumes Task 1 Home fields and pure helpers.
- Produces `pages.work` and `pages.activity` aliases while preserving all old routes.
- Keep `pages.home` as Today and preserve manifest start URL.
- Work consumes existing `api('jobs')`. Preference uses a space-specific filter key.
- Board and list share the same filtered data.
- Existing plan and lane views remain accessible inside Work.

- [ ] Add failing tests for space-specific work preferences and local timestamp formatting.
  Name the helper `workFilterKey(space)`; different spaces must produce different keys.
  `hhmm(ts)` must format the viewer's local time rather than slice UTC.
- [ ] Run the targeted tests and confirm the expected failures.
- [ ] Render Today in the approved order.
  Use deterministic source-linked brief text, actual decisions and tasks, waits, bounded recent job updates, and compact priorities.
  Show an explicit pending-index coverage limitation.
- [ ] Replace primary navigation and move administration behind Settings.
  Use Data connected for transport state.
  Use Sample space for fixtures.
  Keep old routes working and make agent freshness distinct from runtime presence.
- [ ] Add prioritized Work list and persistent per-space board toggle.
  Keep the existing filters and shared detail panel.
  List stages outside the standard board visibly.
- [ ] Add Activity alias and preserve full log access.
  State the current read window. Do not imply complete history.
- [ ] Show unavailable schedule and run capabilities honestly on Agents.
  Do not invent provider limits, schedule slots, or Run now handlers.
- [ ] Run targeted tests and `node --test test/live-shell.test.mjs`.
  Expected: all pass after justified label updates.
- [ ] Start isolated seeded preview on port 4330.
  Use CUA to check Today, decision access, Work list/board, legacy routes, Settings, and space changes.
  Verify 390, 768, and 1280-pixel layouts.
- [ ] Commit the dashboard views.

### Task 3: Decision context, receipts, and joined verification

**Files:**
- Modify: `public/app/cards.js`, `actions.js`, `shell.js`
- Test: `test/dashboard-foundation.test.mjs`
- Reuse: existing decision, browser hardening, and space-race tests.

**Interfaces:**
- Consume Task 1 `decisionProblem`.
- A successful decision writes `live.decisionReceipt` with space, trail, verdict, summary, and source job.
- Shell displays that receipt only in its originating space.
- Server verdicts remain approve, reject, and defer.
- Request changes uses reject plus a required reason.

- [ ] Add failing receipt-scope tests before implementing the helper.
  Export `receiptForSpace(receipt, space)`: return the receipt only for an exact matching space.
- [ ] Run the test file; confirm the expected failure.
- [ ] Improve decision cards with the exact action and collapsed provenance.
  Disable approval for a missing action and show the reason.
  Label Request changes and Decide later clearly.
  Keep existing irreversible confirmation and signed decision binding.
- [ ] Enforce change reasons before submission.
  Only save receipts after a successful server response.
  Show Approval saved. Completion not verified.
  Keep failed-action notes intact.
- [ ] Run full CI with local test-server permissions.
  Command: `npm run ci`.
  Expected: all tests, schema, and 30 conformance cases pass.
- [ ] Use CUA with synthetic sample data to verify decision review, a safe defer, receipt text, and space isolation.
  Record screenshots and actual limitations.
- [ ] Commit the verified result and request a fresh whole-branch review.
- [ ] Resolve important findings with a reproduced failing test.
- [ ] Prepare a draft PR and attach it to the chat.
  Do not enable paid Vercel agent reviews.
  Keep runtime-dependent phases listed as follow-up work.

