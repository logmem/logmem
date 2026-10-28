# Browser repair plan

The current HTML app needs consistent controls and truthful coordination status.

## Scope and design

Keep the existing HTML dashboard and server authorization.
Use small palette dots with accessible names and native keyboard selection.
Show a named space menu with existing permitted actions.
Keep fleet spaces distinct from customer workspaces. Navigation does not grant access.
Keep Keys and Connections inside the dashboard appearance through PR 167.
Apply the verified homepage spacing and setup patch.
Mount Clerk's supported sign-in component inside LogMem chrome at `/sign-in`.
Keep account entry and connection entry callbacks separate.
Preserve validated local destinations and server verification after authentication.

## Work

- [x] Sync current main and owners. OpenCode confirmed no Keys or Connections edits.
- [x] Repair full-source coordination backfill and add dry-run safety tests.
- [x] Add manager resolution with a required reason, race checks and durable audit history.
- [x] Remove resolved items from both open indexes atomically.
- [x] Teach daily audits to honor canonical settlements without forged agent receipts.
- [x] Retain audit windows and intentional mirror opt-out counts.
- [x] Distinguish unavailable receipt sources from empty results.
- [x] Show saved checks rather than an implied running scheduler.
- [x] Add palette dots and role-aware space actions.
- [x] Integrate homepage spacing and connection guidance.
- [x] Add branded Clerk sign-in with safe return paths and a scoped content policy.
- [x] Finish integration browser checks and independent review.
- [ ] Publish reviewed source through the existing release path.
- [ ] Run a reviewed history-indexing dry run against the selected deployment.
- [ ] Verify real provider sign-in, invitation return and session recovery after release.

## Operational alignment

OpenCode keeps customer spaces, contributor access and live hero verification.
Antigravity keeps the existing stale-handoff and release review lane.
Ops Center must supply runner and schedule evidence through the existing scheduler audit.
Codex prepares integration code and verifies the user-facing flows.

No task completion or agent success follows from a roster read.
No existing handoff is deleted by manager resolution.
A manager closes only the coordination request. Linked work stays open.
Mirror parity repair requires observed writer policy and samples before replay.

## Acceptance

Desktop and phone users can choose themes and reach space management actions.
Viewers cannot use manager controls.
Managers can resolve a retired recipient's indexed request with a recorded reason.
Replayed saves preserve one result and the original human identity.
Audits do not restore resolved requests as unanswered failures.
Coverage stays partial when a source fails, a scan is bounded or evidence is ambiguous.
The sign-in page preserves a permitted destination without exposing the server secret.
An unavailable provider leaves a visible retry path inside LogMem branding.
Live acceptance includes the exact deployed revision and actual provider sign-in.

## Verified candidate

The candidate includes main through `3cc70d8` and preserves its flow views.
All 981 repository tests and 84 desktop and phone browser cases pass.
Schema checks and 30 conformance checks pass.
Independent review found callback routing and orphan-source discovery gaps. Both have regression checks.
Provider browser tests use a Clerk fixture. Actual provider sign-in remains a release check.
Legacy source names with colons still require a reviewed migration before full coverage.
No live backfill, mirror replay or scheduler provisioning ran.
