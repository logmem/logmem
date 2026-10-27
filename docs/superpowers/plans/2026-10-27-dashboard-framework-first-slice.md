# Dashboard Framework First Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Use sequential execution unless the operator authorizes delegation.

**Goal:** Build a runnable protected Next.js dashboard with real space selection and a read-only Today view.

**Architecture:** Add a private npm workspace under apps/dashboard. Use Clerk's Next.js integration for identity and existing LogMem services for authorization and data. Keep production HTML and root APIs available until a separately approved cutover.

**Tech Stack:** Node 22 CI, Node 24 deployment check, Next.js 16.4.3, React and React DOM 19.3.1, @clerk/nextjs 7.9.22, TypeScript, CSS modules, npm and Playwright.

**Spec:** docs/superpowers/specs/2026-10-27-dashboard-framework-migration-design.md

Status: planning proposal. Michael chose migration planning first. Do not treat this plan as implementation or release approval.
Overall roadmap: docs/superpowers/plans/2026-10-24-nextjs-vercel-dashboard.md.

## Global constraints

- Keep root MCP package exports, files, commands and release behavior intact.
- Use /app as the Next.js basePath. Keep root /api, /mcp, OAuth and public pages with the current service.
- Keep White, Sage, Sand and Midnight. White remains the default.
- Use the existing provider instance and customer storage. Add no database or paid model service.
- Recheck authorization for every protected read and mutation. Serialize no Redis runner or secret into browser props.
- Keep cacheComponents disabled and private viewer data out of shared persistent caches.
- Never replay mutations automatically. Do not weaken revocation or closed-signup behavior.
- Keep public page creation with Muse, account/admin contracts with OpenCode and identity review with Antigravity.
- No cloud project, credential, provider, domain or production change follows from local implementation approval.

## Review focus

1. An expired session must recover without loops, stale private content or duplicate writes.
2. Direct foreign-space URLs and revoked users must never reveal another customer's data.
3. Old hash links and encoded return paths must preserve safe navigation without external redirects.
4. Space switches and two-tab signout must discard stale responses and cached customer state.
5. Project routing must keep Next assets working and preserve public pages, OAuth and MCP during rollback.

## Task 1: Runnable workspace and build boundary

**Owner:** Codex. **Independent review requested from:** Hermes.

**Files:** Modify root package.json and package-lock.json. Create apps/dashboard/package.json, tsconfig.json, next-env.d.ts, next.config.ts, app/layout.tsx, app/page.tsx, styles/tokens.css, tests/foundation.test.ts and playwright.config.ts. Modify .github/workflows/ci.yml.

**Interfaces:** Private workspace @logmem/dashboard exposes dev, build, start, typecheck, test and test:e2e scripts. basePath is /app. The root package's existing scripts remain unchanged.

- [ ] Add failing foundation checks for the /app base path, private package identity and absence of dashboard files in npm pack output.
- [ ] Run the new foundation checks and verify failure because the workspace foundation does not exist.
- [ ] Add the workspace and pinned runtime packages. Resolve compatible TypeScript and type packages, pin them and commit the root lock.
- [ ] Add ClerkProvider at the root and the required HTML layout. Missing provider configuration must show an explicit setup failure, never a fake signed-in state.
- [ ] Use semantic CSS tokens from the current UI. Add no Tailwind dependency for the existing class sketches.
- [ ] Add build and typecheck jobs beside the existing root checks. Run npm ci at the repository root.
- [ ] Run npm run build --workspace @logmem/dashboard and npm run typecheck --workspace @logmem/dashboard. Both must exit 0.
- [ ] Run npm pack --dry-run --json. Assert the root package includes no apps/dashboard artifacts.
- [ ] Run the current root suite once after package changes. Commit only the reviewed foundation files.

**Exit:** A runnable app builds, the existing MCP package retains its contract and no project link changed.

## Task 2: Provider identity, request adaptation and safe return

**Owner:** Codex. **Review requested from:** Antigravity and OpenCode.

**Files:** Create apps/dashboard/proxy.ts, lib/server/session.ts, lib/return-path.ts, tests/session.test.ts and tests/return-path.test.ts. Modify apps/dashboard/app/sign-in/[[...sign-in]]/page.tsx and lib/server/viewer.ts.

**Interfaces:** requireDashboardSession(): Promise<{userId:string}> returns SDK-verified identity. It throws DashboardSessionError with code signed_out, session_renewal_required or session_unavailable. safeDashboardReturn(value:unknown): string accepts only validated local /app destinations. resolveDashboardViewer retains its current action and selector interface.

- [ ] Add rejection tests for external URLs, protocol-relative URLs, encoded separators, control characters, backslashes and unsupported paths.
- [ ] Add session tests for verified identity, signed-out, renewal-required and unavailable provider states. Assert no token values enter returned DTOs or errors.
- [ ] Run these tests and verify missing helpers fail.
- [ ] Implement proxy.ts using Clerk integration. Opt in to protected-route checks explicitly.
- [ ] Implement a server-only SDK identity bridge. Construct the existing service dependency closure inside trusted server code.
- [ ] Use the official sign-in component with validated local continuation. Await asynchronous App Router request APIs and search parameters.
- [ ] Pass the real request context and a configured trusted origin into viewer resolution. Never trust a browser-supplied identity or namespace.
- [ ] Run app unit tests, typecheck and build. All must pass.
- [ ] Run test/dashboard-two-identity.test.mjs against the reused viewer adapter. All current isolation cases must pass. Commit the identity slice.

**Exit:** Direct protected requests require verified identity and safe returns reject hostile destinations.

## Task 3: Real entry resolution and space selection

**Owner:** Codex. **Account contract review requested from:** OpenCode.

**Files:** Create apps/dashboard/lib/server/entry.ts, lib/server/dto.ts, tests/entry.test.ts and tests/dto.test.ts. Modify app/page.tsx and app/(workspace)/select-space/page.tsx. Reuse src/http/workspaces.mjs and inspectInvitation in src/http/workspace-invites.mjs.

**Interfaces:** resolveEntry(): Promise<EntryDestination> returns invitation, select-space, create-workspace, closed-access, workspace-home or unavailable. EntryDestination is a discriminated union with kind and a validated local href. Unavailable carries no protected identifiers. DashboardShellDto includes user display label, workspace/space names, identifiers and permitted controls only.

- [ ] Add cases for invitation priority, zero spaces with closed signup, one space, several spaces, stale saved choice and removed membership.
- [ ] Add a DTO test that rejects serialization of redis, session tokens and server configuration.
- [ ] Run the tests and verify missing entry/DTO implementations fail.
- [ ] Resolve verified identity, invitation and membership through existing services. Do not create a workspace while listing memberships.
- [ ] Replace the permanent loading sketch with server-loaded authorized choices and explicit empty/error states.
- [ ] Use canonical /app/w/{workspaceId}/s/{spaceId}/today destinations. Revalidate membership when opening the destination.
- [ ] Link unsupported first-slice create/invite operations to their existing HTML flow with a clear return. Do not show inert controls.
- [ ] Run unit tests, typecheck, build and the existing workspace membership tests. Commit the entry slice.

**Exit:** No perpetual loading list, unwanted provisioning or unauthorized saved selection remains in the first slice.

## Task 4: Protected shell and useful Today data

**Owner:** Codex. **Independent UX review requested from:** Hermes.

**Files:** Create app/(workspace)/w/[workspaceId]/s/[spaceId]/layout.tsx, today/page.tsx, loading.tsx, error.tsx, components/workspace-shell.tsx, components/theme-picker.tsx, components/today-view.tsx, styles/shell.module.css, lib/server/views.ts and tests/views.test.ts.

**Interfaces:** getTodayView({workspaceId,spaceId}): Promise<TodayDto> authorizes the viewer and calls buildView with what='home' and the verified person. Client props contain only serializable display data and permitted actions.

- [ ] Add parity tests that compare TodayDto records with buildView using the same memory fixtures and viewer identity.
- [ ] Add foreign-space, revoked-member and unavailable-storage cases. Missing storage must not render a successful empty workspace.
- [ ] Run tests and verify the absent service/UI fail.
- [ ] Build the current approved shell with keyboard navigation, visible focus and the four themes.
- [ ] Render real Today data on the server. Keep links for later views explicit about availability or route them to the current HTML equivalent.
- [ ] Keep actions read-only in this slice. Do not render disabled-looking buttons that imply completed mutation support.
- [ ] Run parity tests, typecheck and production build. Capture 320, 390 and 1280 pixel layouts with approved sample data.
- [ ] Run the production server browser checks for sign-in, protected redirects, layout and keyboard behavior. Commit the Today slice.

**Exit:** A permitted user can reach a useful Today view. A failed authorization cannot expose shell data.

## Task 5: Session continuity and legacy navigation

**Owner:** Codex. **Identity review requested from:** Antigravity.

**Files:** Create components/session-boundary.tsx, components/legacy-entry.tsx, lib/legacy-route.ts, tests/legacy-route.test.ts, tests/session-recovery.test.ts and e2e/session-continuity.spec.ts. Integrate app/page.tsx and the workspace layout.

**Interfaces:** mapLegacyEntry(hash:string,authorizedContext): string|null maps only known views and record references. SessionBoundary renders ready, renewing, signed-out, denied and unavailable states without replacing server authorization.

- [ ] Add legacy-link tests for home/account/work views, valid record references, unknown views and hostile encoded destinations.
- [ ] Add recovery cases for one recovery attempt, repeated failure, revoked membership, service outage and signout in a second tab.
- [ ] Add a mutation-spy assertion that recovery never submits a queued or previous POST.
- [ ] Run the focused tests and verify missing behavior fails.
- [ ] Capture a timed, redacted trace with the provider test instance before choosing the specific SDK recovery hook.
- [ ] Implement the smallest confirmed recovery handling. Retain verified memberships as the access authority.
- [ ] Clear the recovery guard only after successful signed-in bootstrap or explicit user retry.
- [ ] Discard old-space responses and protected client data after membership loss or signout.
- [ ] Run local tests and production-server browser checks. Then run two real identities on the protected preview when its exact access setup has approval.
- [ ] Record source SHA, observation times, initial state, expected destination and actual outcome. Never save authentication payloads. Commit the recovery slice.

**Exit:** Idle recovery needs no manual reload and cannot loop, restore revoked access or replay writes.

## Task 6: Reviewable preview and acceptance receipt

**Owner:** Codex. **Rollout evidence:** Hermes. **Release enforcement:** OpenCode.

**Files:** Create docs/runbooks/dashboard-first-slice-preview.md and e2e/first-slice.spec.ts. Update this plan's receipt section.

- [ ] Run npm run test --workspace @logmem/dashboard, typecheck, build and the relevant browser suite once for the candidate.
- [ ] Run root npm test, npm run spec:check and npm run conformance. Require zero failures and 30/30 conformance cases.
- [ ] Prepare the exact protected project, root directory, build settings and environment-name manifest. Do not reveal values or automatically create/link a project.
- [ ] Obtain the applicable project/access approval before preview publication or credential placement.
- [ ] Configure the protected preview with repository root access for shared services. Verify its resolved project context before deployment.
- [ ] Run actual sign-in, idle refresh, invitations, one/several spaces, closed signup, foreign URLs, removal and two-tab signout.
- [ ] Obtain independent review and record any failed or blocked cases separately from passing local tests.
- [ ] Save source SHA, dependency lock hash, preview identity, exact test results and known gaps.

**Exit:** Protected preview acceptance passes. This exit does not authorize a production cutover.

## Follow-on slices and cutover

| Slice | Reuse | Required proof |
| --- | --- | --- |
| Inbox and Work | customer handlers, canonical coordination queue, stable request identifiers | Same records, original deadlines, action restrictions, uncertain-write handling |
| Team, Knowledge, Health and settings | current membership, keys, decisions, receipts and health contracts | Role parity, managed two-way records, key revocation and honest missing evidence |
| Public page integration | Muse's delivered static files and HANDOFF.md | Content review, A11 and each page's publish approval |
| Cutover | restricted release path and /app prefix routing | Same-origin rehearsal, exact source approval, asset/API checks and rollback |

Before production routing, test /app, nested routes, /app/_next assets and /app/api handlers on one origin.
Verify root /api, /mcp, OAuth, discovery, homepage and docs still reach the current service.
Record and rehearse restoration of the previous routing configuration and HTML deployment.
Do not repoint the existing project's root directory as a shortcut.
Keep AI execution, database replacement, domain migration and paid model work outside these slices.

## Evidence and current gaps

The root baseline has 900 passing tests, schema validation and 30 conformance cases from the approved docs release.
Fourteen focused session/context tests passed during the October 27 UX audit.
No Next.js package install, build or end-to-end run has occurred for this plan.
Independent reviewer capacity, protected preview setup and real provider acceptance remain open.
The task owners are requested collaboration boundaries, not proof that each peer accepted capacity.

## Self-review

Routing, identity, server DTOs, private caching, membership rechecks and non-replayed writes each have an owning task.
Each review-focus failure has a test or preview case above.
The first slice is useful without completing every later view.
Dependencies and shared-file boundaries remain explicit. No application code changes accompany this plan.
