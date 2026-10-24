# Customer dashboard verification, 2026-10-24

The implementation passes local checks. Public signup remains closed.

## Delivery

The branch adds workspace membership, multiple private spaces, customer sessions, invitations, team settings, and scoped agent connections.
Existing agent credentials retain their original namespace grants.
The operator dashboard remains separate.
Customer access and public signup use separate flags. Both remain off by default.

## Evidence

- Full CI: 827 tests passed, zero failures. Generated schema is current. Conformance passed 30 of 30 cases.
- Browser suite: 38 passed, four existing skips, zero failures across laptop and phone.
- Real Redis: atomic creation, retry, membership changes, guarded writes, revocation, and invitation acceptance passed.
- Patch whitespace checks passed. Dependency manifests and lockfiles did not change.
- Phone and laptop captures cover named space navigation and useful empty states.

One independent whole-branch review found five issues. The fix pass addressed all five.
Regression checks cover stale walkthrough drafts, rejected writes, mixed-case identities, closed signup, and key churn.
A VM test harness needed the new context reset hook. Its tests now exercise that hook.
Key and invitation metadata have limits. Audit records and idempotency keys have retention limits.

## Remaining rollout checks

Real Clerk identities, provider signout, protected preview configuration, and actual OAuth reconnect remain unverified.
Task 8 remains partial until those checks pass.
Do not enable public signup based only on synthetic tests.
Follow [the rollout runbook](customer-dashboard-rollout.md) for preview checks and rollback.

## Execution record

# SDD ledger — plan: docs/superpowers/plans/2026-10-23-logmem-multitenant-dashboard.md

Execution: native, authorized by Michael on 2026-10-23.
Base: 2c17164.
Workspace: reuse isolated temporary checkout on codex/multitenant-dashboard-20261023.
Pre-flight: Task 1 registry feeds Task 2 policy and Task 3 viewer. Task 3 feeds Tasks 4–7. All consumers use the same IDs and namespace mapping.
Ruling: reuse the existing temporary clone rather than create another checkout. It has no tracked changes and already isolates fleet work. Cost if wrong: relocate the branch.
Task 1: complete (commits 2c17164..db7e275, tests: node --test test/workspaces.test.mjs test/cloud-tenants.test.mjs → ℹ duration_ms 75.122083)
Task 2: complete (commits db7e275..b9c506e, tests: node --test test/workspaces.test.mjs test/workspace-membership.test.mjs test/workspace-migration.test.mjs test/accounts-invites.test.mjs → ℹ duration_ms 67.892209)
Task 3: complete (commits b9c506e..8fc7bf2, tests: node --test test/workspace-jail.test.mjs test/viewer-context.test.mjs test/two-tenant-isolation.test.mjs test/jail-scripts.test.mjs → ℹ duration_ms 121.048292)
Task 4: complete (commits 8fc7bf2..8d5d35e, tests: node --test test/customer-session.test.mjs test/workspace-handlers.test.mjs test/managed-signin.test.mjs → ℹ duration_ms 103.140167)

Ruling: group delivery into one feature PR after all dependent tasks pass. No intermediate customer release is enabled. Cost if wrong: split the commits before merge.
Ruling: use e2e/customer-onboarding.spec.mjs, matching the existing Playwright configuration. Cost if wrong: update the test path.
Ruling: keep the stateless public signature verifier. It returns no stored data and existing agents depend on it. Cost if wrong: add authenticated verification separately.
Ruling: retain generic human IDs at 64 characters and allow the longer verified Clerk ID form. Preserve case to prevent identity collisions. Cost if wrong: update identity validation.
Ruling: add one atomic policy-version check per storage command, rather than repeated membership reads. Real Redis revocation tests pass. Cost if wrong: reject an in-flight operation and require reload.
Verification: baseline passes 791 tests. Current full CI passes 823 tests and 30 conformance cases before final sample and membership tests.
Verification: real Redis atomic creation, membership, guarded writes, revocation and invitation acceptance pass.
Verification: six new customer browser cases pass across laptop and phone.
Verification: unchanged baseline reproduces old home, decision digest and decision-label browser failures. Update fixtures for the current UI and retain their behavior assertions.

Tasks 5 through 7 pass their targeted checks and full CI.
Task 8 includes migration code, the runbook, local checks, and independent review.
Its real identity and protected preview checks remain open.
