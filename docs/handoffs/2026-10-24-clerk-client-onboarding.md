# Clerk integration and client onboarding

Antigravity owns this handoff request. Michael needs to onboard a client today, October 24.
Accept the LogMem handoff and report an ETA or exact blocker.
OpenCode remains a fallback. Do not start duplicate execution.
Codex retains review support.

## Starting point

- PR: https://github.com/madezmedia/logmem/pull/121
- Branch: `codex/multitenant-dashboard-20261023`
- Verified implementation commit: `07c0794`
- Local checkout: `/private/tmp/codex-launch-final-20261023`
- Preview: https://logmem-cnqokd8xy-mad-ez-media.vercel.app
- Vercel scope: `mad-ez-media`. Project: `logmem`.
- LogMem job: `managed-web-app`.

Fetch this branch into an isolated checkout before editing. Preserve existing work.
PR 120 covers separate coordination work.

The implementation includes verified Clerk sessions, workspaces, private spaces, invitations, team roles, and scoped agent connections.
All 827 tests and 30 conformance checks pass.
Browser checks pass 38 cases, with four existing skips.
Real Redis checks cover atomic writes, membership changes, isolation, and revocation.
Codex fixed all five independent review findings with regression checks.

Read these files first:

- `docs/runbooks/customer-dashboard-rollout.md`
- `docs/runbooks/customer-dashboard-verification-2026-10-24.md`
- `src/http/clerk.mjs`
- `api/session.mjs`
- `api/workspaces.mjs`
- `api/memberships.mjs`
- `public/app/account.js`

## Complete the provider integration

Check the code for missing integration work. Synthetic tests do not prove provider behavior.
Verify the intended Clerk instance, server keys, hosted sign-in and signup, allowed origins, and redirects.
Verify session validation, provider signout, and protected preview configuration.
Keep deployment protection enabled.
Read secret values only when needed. Never print them or include them in source, chat, or LogMem.
Use approved provider storage for secrets.

The ready preview has not passed real identity checks.
Customer dashboard and signup flags remain off by default.
Configure the customer preview through the rollout runbook.
Keep general public signup closed while preparing the client invitation path.

## Prove client readiness

Use two real test identities in separate workspaces.
Verify first login, returning login, workspace creation, private spaces, invitation acceptance, and role changes.
Confirm direct API requests cannot cross tenants or sibling spaces.
Test removed memberships, two-tab signout, and session revocation.
Connect an actual OAuth agent. Test reconnect and revoked grants.
Record each result and environment without exposing credentials.

Prioritize a working invitation path for today's client after these checks pass.
Prepare the client's workspace and invitation workflow when Michael supplies the business name and login email.
Do not send client email without explicit authorization.

If provider access, missing credentials, billing, or another dependency blocks delivery, report the exact missing action immediately.
Do not report a successful build as completed authentication.

## Completion

Return the verified client login URL, isolated workspace and space, working invitation path, and provider test evidence.
Include reviewed fixes and the rollback steps.
Record acceptance, progress, blockers, and final evidence on `managed-web-app`.
State exactly what remains before production onboarding.
