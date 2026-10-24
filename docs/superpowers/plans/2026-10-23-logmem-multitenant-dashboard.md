# LogMem Multitenant Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user selects delegation.

**Goal:** Let verified users create workspaces and spaces, invite teammates, and use the dashboard within their granted access.

**Architecture:** Reuse Clerk for identity and existing Redis infrastructure for tenant data. Add workspace and space registries with server authorization. Keep existing namespaces and bind browser actions to verified humans.

**Tech Stack:** Node.js 22+, ESM, Redis with registered Lua scripts, Clerk backend, lit-html, node:test, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-logmem-multitenant-dashboard-design.md`

## Global Constraints

- Keep existing namespaces intact during migration.
- Keep existing MCP OAuth separate from browser login.
- Existing single-space credentials keep their original scope.
- Adding a dashboard space does not silently grant agent access.
- Approval authority is explicit and separate from general editing access.
- Keep initial search, inbox, calendars, and counts scoped to the selected space.
- Public signup and production settings remain unchanged until preview verification passes.
- Preserve the existing pending-index owner and rolling handoff semantics.
- Do not enable paid autonomous work during signup.
- Do not introduce a new authentication provider or frontend framework.
- All new customer endpoints require authentication in preview and production.

## Review Focus

- Two browser tabs switch accounts or spaces while requests remain pending. Old data must disappear before new content renders.
- Membership changes during a long request. Recheck authorization before mutations commit and before event delivery.
- Workspace creation succeeds but the browser loses its response. A retry must recover the same workspace and first space.
- Legacy token refresh or reconnect occurs after migration. Its space grant must stay unchanged.
- Concurrent owner removal or invite acceptance occurs. Preserve one owner and enforce the intended verified identity.

## Delivery Boundary

Use three dependent pull requests on one implementation branch.
PR A contains Tasks 1–3 and adds backend records behind the customer-dashboard feature gate.
PR B contains Tasks 4–6 and makes customer sessions usable in preview.
PR C contains Tasks 7–8 and completes invitations and launch verification.
Keep signup closed until all three pass.
Do not merge a partially authorized endpoint set into an enabled customer dashboard.

Continue the existing `managed-web-app` job rather than creating competing work.
Its current state assigns Codex, while its original profile names Claude Code.
Record this approved scope on that job before implementation.
Do not change another agent's pending-index work.

## File Responsibilities

| File | Responsibility |
| --- | --- |
| `src/http/workspaces.mjs` | Workspace, space, membership, idempotent creation, and audit records |
| `src/http/workspace-invites.mjs` | Expiring invitation tokens and identity-bound acceptance |
| `src/http/viewer.mjs` | Verified browser identity and per-action space context |
| `src/http/jail.mjs` | Existing single-space jail plus guarded workspace-space runner |
| `src/http/accounts.mjs` | Preserve legacy mapping and migrate account metadata without changing data keys |
| `api/session.mjs` | Customer signin redirect, current-user context, and safe return URLs |
| `api/workspaces.mjs` | Workspace and space management operations |
| `api/memberships.mjs` | Role changes, invitations, and removal |
| `public/app/account.js` | Signin, first workspace, creation forms, and workspace settings |
| `public/app/core.js` | Context identity, request epochs, cancellation, and cache reset |
| `public/app/shell.js` | Workspace and named space controls |
| Existing dashboard APIs | Consume the shared authorized viewer instead of operator identity |

### Task 1: Workspace and Space Registry

**Files:** Create `src/http/workspaces.mjs`, `test/workspaces.test.mjs`.

**Interfaces:**
- `createWorkspace({userId, name, firstSpaceName, requestId}, deps)` returns `{workspace, space, created}`.
- `createSpace({userId, workspaceId, name, requestId}, deps)` returns `{space, created}`.
- `listWorkspaces({userId}, deps)` returns authorized active workspace summaries.
- `listSpaces({userId, workspaceId}, deps)` returns authorized active space summaries.
- Dependencies include `{redis, now, newId, limits}` for deterministic tests.
- Workspace records use `{id, tenantId, name, status, createdAt}`.
- Space records use `{id, workspaceId, namespace, name, status, createdAt}`.
- IDs are generated server-side. Names contain 1–80 trimmed characters and no control characters.
- New namespaces use `s-<random hex ID>` and remain immutable.
- Membership and space grants never derive from names or slugs.
- Idempotency binds authenticated user, operation, and input digest. A reused key with changed input returns 409.
- Start with 3 owned workspaces per user and 10 spaces per workspace. Enforce atomically and allow server configuration.

- [ ] Step 1: Write tests for two owners, multiple spaces, foreign IDs, stale indexes, concurrent creation, quota races, and lost-response retries.
  Assert one committed workspace, one first space, owner membership, and one audit event for concurrent identical requests.
  Assert changed-input retry returns 409 and lists never expose another tenant.
- [ ] Step 2: Run `node --test test/workspaces.test.mjs`. Expected: failure because the module does not exist.
- [ ] Step 3: Implement atomic registered scripts for records, indexes, quotas, and idempotency. Validate every script key explicitly.
  Write metadata to a new `lm:workspace:*` control-plane namespace outside all customer data jails.
  Keep workspace tenant records compatible with existing plan and status checks.
- [ ] Step 4: Run `node --test test/workspaces.test.mjs test/cloud-tenants.test.mjs`. Expected: all pass.
- [ ] Step 5: Commit the registry and its tests with `feat: add workspace and space registry`.

### Task 2: Membership Policy and Legacy Mapping

**Files:** Modify `src/http/workspaces.mjs`, `src/http/accounts.mjs`. Create `test/workspace-membership.test.mjs`, `test/workspace-migration.test.mjs`.

**Interfaces:**
- `authorizeSpace({userId, workspaceId, spaceId, action}, deps)` returns `{workspace, space, membership, person}` or a fixed authorization error.
- Actions: `read`, `write`, `approve`, `manage-members`, `manage-connections`, `create-space`.
- `setMembership({actorId, workspaceId, userId, role, spaces, requestId}, deps)` updates membership with an audit record.
- `removeMembership({actorId, workspaceId, userId, requestId}, deps)` revokes access atomically and protects the last owner.
- `ensureLegacyWorkspace({userId, tenantId}, deps)` maps the existing verified account to metadata while retaining `t-{tenantId}`.
- Existing mapping ownership is verified from `lm:account:tenant:{tenantId}`. Never adopt an arbitrary supplied tenant.
- Owners/admins can read and edit workspace spaces. Members/viewers require explicit grants.
- Space grants use `editor` or `viewer`, with `canApprove` separate. Workspace owner can manage approval grants.
- Initial creator receives approval rights in the first space. Admin role alone does not confer approval rights.
- Suspended or deleted tenants, workspaces, spaces, and memberships fail closed.

- [ ] Step 1: Write role-matrix tests, sibling-space rejection, forged ownership, migration retry, downgrade, and concurrent last-owner removal tests.
  Assert exactly one owner remains after concurrent removal attempts.
  Assert migration changes no existing data keys or app grants.
- [ ] Step 2: Run `node --test test/workspace-membership.test.mjs test/workspace-migration.test.mjs`. Expected: missing-interface failures.
- [ ] Step 3: Implement authoritative membership checks, atomic role updates, ownership protection, and idempotent legacy mapping.
- [ ] Step 4: Run those tests plus `test/workspaces.test.mjs` and existing account tests found with `rg --files test | rg 'account|managed'`.
  Expected: all pass. Record the resolved test names in the execution ledger.
- [ ] Step 5: Commit with `feat: enforce workspace and space memberships`.

### Task 3: Authorized Storage Context

**Files:** Modify `src/http/jail.mjs`. Create `src/http/viewer.mjs`, `test/workspace-jail.test.mjs`, `test/viewer-context.test.mjs`.

**Interfaces:**
- `resolveViewer(req, {workspaceId, spaceId, action}, deps)` verifies Clerk identity and calls Task 2 authorization.
  Return `{userId, person, workspaceId, spaceId, namespace, role, permissions, redis, revalidate}`.
- `person` is `human:<verified Clerk user ID>`.
- `revalidate()` repeats membership and tenant checks before mutation commitment or live-event delivery.
- `createSpaceJail(redis, {tenantId, namespace}, limits)` is internal and only accepts an authoritative mapping resolved by the viewer.
- Keep `createJail(redis, tenantId)` unchanged for legacy agent credentials.
- Browser APIs use customer Redis for customer records. Never fall back to operator storage when customer configuration fails.
- Signed-out context returns 401. An unavailable configuration returns 503. Missing and foreign spaces return the same fixed 404.

- [ ] Step 1: Write tests that deny foreign keys, scripts, sibling-space commands, forged request identities, missing configuration, and revoked memberships.
  Assert existing single-space agent tokens cannot access a newly created sibling space.
  Assert a membership removed between resolve and revalidate prevents mutation.
- [ ] Step 2: Run `node --test test/workspace-jail.test.mjs test/viewer-context.test.mjs`. Expected: missing-interface failures.
- [ ] Step 3: Implement viewer resolution and guarded storage without broadening legacy token permissions.
  Retain registered-script restrictions and declared-key checks.
- [ ] Step 4: Run these tests plus `test/two-tenant-isolation.test.mjs` and `test/jail-scripts.test.mjs`. Expected: all pass.
- [ ] Step 5: Commit with `feat: resolve authorized dashboard storage contexts`.

### Task 4: Customer Sessions and Management API

**Files:** Create `api/session.mjs`, `api/workspaces.mjs`, `test/customer-session.test.mjs`, `test/workspace-handlers.test.mjs`.
Modify `src/http/clerk.mjs`, `api/logout.mjs`, `vercel.json` only where required by session routing.

**Interfaces:**
- `GET /api/session` returns `{user, workspaces, spaces, selected, onboarding}` from authorized records only.
- `GET /api/session?signin=1&returnTo=/app` performs a top-level Clerk redirect and handshake.
- Allow same-origin relative return paths only. Reject protocol-relative, external, malformed, and encoded redirect escapes.
- `POST /api/workspaces` supports `create-workspace` and `create-space` with the Task 1 input shapes.
- Creation requires `X-LogMem-Intent: workspace`, same-origin protection, a verified session, and an idempotency key.
- Use public signup policy from the existing invite gate. Signed-in invited users can preview onboarding before public signup opens.
- Customer signout must terminate the provider session, then clear local customer state. Clearing only `lm_admin` is insufficient.
- Check the installed Clerk API and official documentation before implementing provider-session revocation.
- Keep `/api/login` and existing fleet operator behavior explicit and separate.

- [ ] Step 1: Write tests for signed-out, handshake, verified account, invitation-only gate, first workspace, returning membership, malicious redirects, CSRF, and signout.
  Assert accepting a membership does not provision a second personal workspace.
- [ ] Step 2: Run `node --test test/customer-session.test.mjs test/workspace-handlers.test.mjs`. Expected: missing-handler failures.
- [ ] Step 3: Implement dependency-injected handlers using Tasks 1–3 and existing Clerk authentication.
  Return no-store responses and bounded validation errors without foreign identifiers.
- [ ] Step 4: Run those tests plus existing Clerk and connection handler tests. Expected: all pass.
- [ ] Step 5: Commit with `feat: add customer dashboard sessions and workspace creation`.

### Task 5: Convert Every Dashboard Data Path

**Files:** Modify `api/view.mjs`, `api/work.mjs`, `api/blockers.mjs`, `api/decide.mjs`, `api/scorecard.mjs`, `api/inbox/[agent].mjs`, `api/connections.mjs`, `api/agent-keys.mjs`.
Modify `api/oauth/authorize.mjs`, `api/oauth/_lib/storage.mjs`, `api/mcp.mjs`, `src/http/auth.mjs` for explicit workspace/space grants only.
Create `test/customer-dashboard-isolation.test.mjs`, `test/workspace-oauth.test.mjs`.

**Interfaces:**
- Customer browser routes consume Task 3 viewer context and its `person`, `namespace`, permissions, and runner.
- Existing operator requests use a distinct explicit operator mode. A failed customer session never falls back to that mode.
- Replace returned environment space lists with authorized workspace/space summaries.
- Writes revalidate membership and enforce the specific action. Decision routes retain exact recipient and action checks.
- Customer connections are scoped to selected workspace and allowed spaces. Only authorized managers can revoke grants or issue agent keys.
- OAuth consent shows selected workspace, space, agent, and scope. Validate selections again when issuing grants.
- New OAuth grants retain immutable tenant/space identity and issuing membership. Removal invalidates affected grants on the next use or refresh.
- Legacy grants retain their exact current single-space semantics. Refresh cannot add spaces.
- `/api/waitlist`, `/api/invites`, verification tools, and cron routes remain operator-only.
- Public health and OAuth discovery return no customer data.

- [ ] Step 1: Write an endpoint matrix covering anonymous, foreign tenant, sibling space, viewer, editor, approver, revoked member, and operator requests.
  Include pulse, needs, search, inbox, scorecard, walkthrough writes, blockers, decisions, keys, and connections.
  Assert 401 for signed-out and uniform 404 for missing or foreign resources.
  Assert customer-supplied identity never appears as the audit author.
  Assert refreshed legacy tokens cannot read sibling spaces, and removed issuer membership revokes new grants.
- [ ] Step 2: Run `node --test test/customer-dashboard-isolation.test.mjs test/workspace-oauth.test.mjs`. Expected: current operator-only behavior fails customer cases.
- [ ] Step 3: Convert handlers through the shared viewer and extend grants with explicit authorization.
  Keep operator tools inaccessible to customer roles, including workspace owners.
- [ ] Step 4: Run new tests plus `npm run ci`. Expected: all tests, schema, and conformance pass.
- [ ] Step 5: Commit with `feat: authorize customer dashboard and agent access by space`.

### Task 6: Signup and Named Space Dashboard

**Files:** Create `public/app/account.js`, `test/dashboard-account.test.mjs`, `test/e2e/customer-onboarding.spec.mjs`.
Modify `public/app/core.js`, `main.js`, `shell.js`, `views.js`, `actions.js`, `search.js`, `drawer.js`, `walk.js`, `public/app.css`, and `public/index.html`.

**Interfaces:**
- Bootstrap from `GET /api/session` before customer dashboard data loads.
- `switchContext({workspaceId, spaceId})` increments a request epoch, aborts in-flight reads, clears panels, caches, dialogs, receipts, and subscriptions.
- Ignore all responses whose captured context epoch differs from the current epoch.
- Store preferences per verified user. Revalidate any remembered selection against current memberships.
- React to cross-tab signout and membership changes. Clear unauthorized content immediately after a 401 or access revocation.
- Show signup, first workspace, named-space switcher, Create space, and workspace settings.
- Initial empty space offers Add a task, Connect an agent, and Invite a person.
- Existing walkthrough creation supplies Add a task. Do not create another task model.
- Business type is optional. Sample selection copies only visibly labeled sample records into the new isolated space.
- Samples use existing business-space seed definitions. No sample can send messages, connect an account, or schedule work.
- Keep Today, Work, Agents, and Activity and the existing design tokens, fonts, and logos.

- [ ] Step 1: Write browser tests for signup to first space, create second space, switching, account changes, mobile controls, lost creation response, and useful empty states.
  Delay a response from space A, switch to B, then release A. Assert A never renders.
  Test signout across tabs and revoked membership during a drawer request.
  Verify text entered in names renders as text, keyboard focus survives validation, and failed creation retains the form.
- [ ] Step 2: Run the new model and browser tests with mocked local APIs. Expected: current dashboard lacks the customer flows.
- [ ] Step 3: Implement session bootstrap, forms, authorized navigation, context reset, and permission-aware actions.
  Keep sample data and actual customer state visibly distinct.
- [ ] Step 4: Run `node --test test/dashboard-account.test.mjs` and the new Playwright file.
  Expected: all pass at desktop and phone viewport sizes.
- [ ] Step 5: Commit with `feat: add customer signup and workspace dashboard flows`.

### Task 7: Invitations and Team Administration

**Files:** Create `src/http/workspace-invites.mjs`, `api/memberships.mjs`, `test/workspace-invites.test.mjs`, `test/membership-handlers.test.mjs`.
Modify `public/app/account.js` and Task 6 browser tests.

**Interfaces:**
- `createInvitation({actorId, workspaceId, email, role, spaces, requestId}, deps)` returns a one-time link and metadata.
- `acceptInvitation({userId, verifiedEmail, token}, deps)` atomically creates or updates the intended membership.
- `revokeInvitation({actorId, workspaceId, invitationId}, deps)` prevents later acceptance.
- Tokens contain 32 random bytes. Store only their digest and expire after exactly seven days.
- Initial invitation roles are admin, member, or viewer. Owner promotion uses explicit membership administration.
- Limit pending invitations to 50 per workspace and creation attempts to 20 per actor per hour.
- UI shows workspace, role, and granted spaces before acceptance. No raw token appears in logs or analytics.
- Provide Copy invitation link initially. Email delivery requires explicit configuration and can follow separately.
- Removal or downgrade revokes old access and stops unauthorized actions. Recheck the actor inside atomic mutation handling.

- [ ] Step 1: Write tests for wrong verified email, expiry boundary, revocation, token secrecy, role tampering, quota races, repeat acceptance, and concurrent owner removal.
  Test an invite accepted while revoked and a membership changed while an action is pending.
- [ ] Step 2: Run `node --test test/workspace-invites.test.mjs test/membership-handlers.test.mjs`. Expected: missing-module failures.
- [ ] Step 3: Implement invitation storage, acceptance, role endpoints, member settings, and copy-link flow.
  Integrate Task 2 last-owner protections and audit events.
- [ ] Step 4: Run new tests and customer onboarding browser tests. Expected: all pass.
- [ ] Step 5: Commit with `feat: add scoped workspace invitations and team roles`.

### Task 8: Migration, Preview Verification, and Rollout

**Files:** Create `scripts/workspace-migrate.mjs`, `test/workspace-rollout.test.mjs`, `docs/runbooks/customer-dashboard-rollout.md`.
Modify the new tests where complete browser flows need additional assertions.

**Interfaces:**
- Migration defaults to dry-run and uses explicit tenant/user pairs from verified existing ownership records.
- `--apply` creates metadata only. It cannot rename data namespaces, change tokens, or assign fleet spaces to arbitrary users.
- Customer dashboard feature gate defaults off. Signup gate remains independently controlled.
- Rollback disables new creation and customer dashboard entry without deleting workspaces, grants, or user data.
- No automatic provider fallback, model execution, or agent schedule starts during onboarding.

- [ ] Step 1: Write migration and rollback tests for legacy accounts, partial records, repeated execution, suspended tenants, and unrelated fleet namespaces.
- [ ] Step 2: Run `node --test test/workspace-rollout.test.mjs`. Expected: missing-script failure.
- [ ] Step 3: Implement dry-run migration and the rollout runbook with exact environment controls and recovery steps.
- [ ] Step 4: Run `npm run ci`, new Playwright flows, `git diff --check`, and dependency/license checks for any changed packages.
  Expected: all pass. Record actual counts and failures without treating blocked GitHub Actions as a pass.
- [ ] Step 5: Conduct one independent whole-branch review focused on isolation, identity, quotas, and browser races.
  Fix material findings with regression tests, then repeat the affected checks.
- [ ] Step 6: Verify preview with two real test identities, separate workspaces, sibling spaces, role changes, invitations, and OAuth reconnect.
  If test identities or provider configuration are unavailable, record the missing evidence and keep rollout closed.
- [ ] Step 7: Commit the runbook and verification evidence with `test: verify multitenant dashboard rollout`.

## Execution Choice

Recommend native implementation in this session with one independent final review.
The tasks share security-sensitive interfaces, so one implementer keeps those interfaces consistent.
Delegation remains available if the user prefers separate task reviewers.

## Self-Review

The plan covers signup, spaces, memberships, invitations, agent grants, isolation, migration, UX, and rollout.
Every shared interface has a producer task before its consumer.
Each Review Focus item has a matching test task.
Existing namespace and single-space credential compatibility remain explicit.
Automatic email delivery, billing collection, workspace-wide search, and new agent frameworks remain outside this release.
Approval authority remains separate from editor and admin access.

Implementation has not started. The next skill step requires plan review and selection of the execution method.
