# Dashboard Interactions Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution. Complete one independent final review.

**Goal:** Add comments, safe reassignment, and canonical item nudges to the dashboard.
**Architecture:** A space-scoped interaction service owns atomic receipts and journals. One authenticated API serves operator and customer contexts.
**Tech Stack:** Existing Node.js, Redis Lua registry, native lit-html, and Playwright.
**Spec:** docs/superpowers/specs/2026-10-24-dashboard-interactions-design.md

## Global Constraints

- Never change approval rights through comments or reassignment.
- Preserve original handoff deadlines and canonical indexes.
- Require verified identity, selected space permissions, same origin, and intent on writes.
- Keep user text escaped and drafts isolated by space.
- Add no dependencies or paid services.

## Review Focus

- Concurrent ownership changes and task progress survive retries.
- Revoked access cannot expose cached discussions.
- Request ID reuse cannot change targets or duplicate entries.
- Notification failure leaves a retryable receipt.
- Partial canonical index coverage remains visible.

### Task 1: Atomic interaction service

Files: src/http/interactions.mjs, test/interactions.test.mjs.
- [ ] Add failing tests for target validation, comments, pagination, CAS reassignment, request replay, cooldown, and source delivery failures.
- [ ] Run the tests and confirm missing module failures.
- [ ] Implement the service and jail-safe registered transaction.
- [ ] Run interaction and existing work tests, then commit.

### Task 2: Authenticated API

Files: api/interactions.mjs, scripts/dev-site.mjs, test/interaction-handlers.test.mjs.
- [ ] Add failing operator and customer authorization tests.
- [ ] Implement GET discussion/queue and POST comment/reassign/nudge with existing auth helpers.
- [ ] Verify foreign spaces, viewers, stale ownership, invalid recipients, and intent checks, then commit.

### Task 3: Dashboard controls

Files: public/app/interactions.js, public/app/drawer.js, public/app/cards.js, public/app/views.js, public/app.css, e2e/interactions.spec.mjs.
- [ ] Add failing browser checks for comments, reassignment, queue nudges, retry, and space changes.
- [ ] Implement shared discussion controls and a canonical queue view in existing navigation.
- [ ] Run browser checks on laptop and phone, then commit.

### Task 4: Delivery verification

Files: docs/runbooks/dashboard-interactions-verification-2026-10-24.md.
- [ ] Run full CI, browser checks, real Redis probes, and whitespace checks.
- [ ] Conduct one independent final review and address important findings with regression checks.
- [ ] Record dependency and coverage limits. Publish a draft PR based on PR 121.
