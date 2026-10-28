# Dashboard framework migration

Move the customer dashboard to Next.js in verified stages.

Date: October 27, 2026. Owner: Codex. Status: planning proposal for review.
Michael chose "Plan framework migration first" in the Codex thread.
This choice authorizes planning. Implementation and release require their applicable review gates.

## Baseline and changes to the earlier plan

Main is 3f54c8d99652bf8428dc300d05b60d1851cb73b7.
The October 24 milestone plan remains the overall roadmap.
This design replaces its first two milestone boundaries with one useful protected vertical slice.
It also defines routing, session recovery, shared-service access and cutover requirements.

The repository contains four dashboard files: a JavaScript viewer adapter, its TypeScript wrapper and two route sketches.
It has no dashboard package manifest, root layout, build configuration or working selection UI.
PR 143 delivered authorization code. It did not deliver a runnable protected Next.js application.
Existing two-identity tests exercise the viewer adapter with memory storage.
Those tests do not establish browser session continuity or a working deployment.

The current browser can lose its session presentation after idle time.
A fresh sign-in attempt reached a network error. Reload restored Operations settings.
The error's root cause remains unknown. Framework migration alone does not prove a fix.
Public pricing, connect, privacy and terms routes returned 404 at 6:20 PM EDT.
Muse has since supplied page files for integration review. Her handoff retains per-page publish and A11 gates.

## Alternatives

| Approach | Benefit | Cost |
| --- | --- | --- |
| Isolated dashboard with shared services, recommended | Enables independent preview and staged route acceptance | Requires explicit project and same-origin routing checks |
| Replace the current root deployment immediately | Uses one application project | Couples dashboard work to public pages, OAuth, MCP and rollback |
| Add Next.js and a new database together | Allows a broader backend redesign | Duplicates storage and introduces migration, cost and self-host dependencies |

Use the first approach. Keep Redis, Clerk identity and existing LogMem authorization.
Add no new database, queue, paid model service or framework-dependent record format.

## Runtime and package boundaries

Build apps/dashboard as a private npm workspace named @logmem/dashboard.
Register that workspace in the root package manifest and maintain one root package lock.
Keep root MCP package exports, files, commands and release behavior intact.
Use Node 22 for CI, matching the repository's .nvmrc. Verify the deployed Node 24 build separately.
Pin Next.js 16.4.3, React 19.3.1, React DOM 19.3.1 and @clerk/nextjs 7.9.22.
Verify TypeScript and type-package compatibility during the foundation task and lock the resolved versions.
Do not use a latest-version install command during implementation.

Use App Router, TypeScript and the existing semantic CSS tokens.
Use CSS modules for new component styles. Do not add a second design system.
Preserve White, Sage, Sand and Midnight. White remains the default.
Keep cacheComponents disabled for the first customer slice.
Do not place private viewer data in shared persistent caches.

## Routes and coexistence

Set the Next.js basePath to /app.
Canonical customer routes use /app/w/{workspaceId}/s/{spaceId}/{view}.
The six view names are today, inbox, work, team, knowledge and health.
Work detail adds /work/{jobId}. Account management uses /settings.
The selector lives at /app/select-space. Sign-in lives at /app/sign-in.
Next-owned browser commands live below /app/api/customer/.
Root /api, /mcp, OAuth, discovery and public pages remain with the existing service.

A client compatibility component reads old /app#/... fragments.
It maps only known views and validated record selectors to new local destinations.
The server never sees fragments. It authorizes the destination independently.
Unknown legacy links show a useful missing-page state with an authorized Today link.
Never accept an external, protocol-relative, multiply encoded or backslash return destination.
Keep the root API's existing return validator separate until a reviewed compatibility change needs it.

First run locally. Then request a protected preview with its own verified project context.
Do not relink or repoint the existing production project during the foundation work.
Before any new project, preview credentials, provider setting or production route change, prepare the exact action for approval.
The preview must demonstrate session cookies and redirects on its actual origin.
A production cutover later routes the entire /app prefix, including Next assets and nested handlers, to the dashboard.
It must preserve /app in the upstream path and test encoded paths, query strings and trailing slashes.
No production cutover occurs until a same-origin preview rehearsal proves those rules.

## Identity and authorization

Use the official Clerk Next.js integration with ClerkProvider and proxy.ts.
Proxy handles request-level identity and redirect concerns. It does not grant workspace access.
Create a server-only session bridge that exposes a verified provider identity to existing LogMem services.
Only trusted server code can supply the dependency closure that carries that identity.
Never accept identity, role, namespace or Redis credentials from a browser body or query.

Reuse resolveDashboardViewer and authorizeSpace. Recheck them at each read or mutation boundary.
Do not serialize the viewer's Redis runner, provider session or server-only context into client props.
Return a minimal DashboardShellDto containing names, identifiers and permitted controls.
Keep authorization checks close to every service call, including direct route handler calls.
Review the existing adapter's duplicated jail/version logic before expanding it.
Consolidate shared authorization only when parity tests demonstrate identical rejection behavior.

## Entry and recovery

Resolve identity, invitations, creation eligibility and authorized spaces in that order.
A valid invitation takes priority over ordinary space selection.
One authorized space opens Today. Several spaces show a real selector.
A saved choice is only a preference. The server must still grant it.
No workspace plus closed access shows an invitation explanation, not a failing create form.

Use provider-managed session refresh in the Next.js runtime.
Model signed-out, renewing, denied, unavailable and ready states explicitly.
The exact provider error still needs a timed, redacted trace before implementation selects its handling.
Allow one recovery navigation per destination until successful signed-in bootstrap or explicit retry.
Repeated failures show a clear retry or sign-in action instead of looping.
Recheck membership after renewal. Revoked membership must remain revoked.
Clear protected content on signout or confirmed access loss.
Do not describe a service outage as changed membership.
Never automatically replay a mutation after renewal, timeout or transport failure.
Preserve non-secret form fields in memory where possible. Explain unsaved changes before navigation.

## Data and mutations

Server Components read initial data through existing buildView and the authorized viewer runner.
A server-only customer request adapter calls existing customer handlers in-process.
It converts Request and Response envelopes without adding a second command implementation.
Use an explicit route allowlist. Preserve origin, intent, action identity and error semantics.
Do not grant access merely because a request passed through the adapter.

Client components handle forms, navigation, drawers and refresh controls.
After a successful write, refresh the affected server view.
Use existing idempotency where available. Where commands lack it, do not promise safe automatic retries.
Space changes cancel reads. Discard responses whose workspace or space no longer matches.
Keep coordination queue, deadlines, receipts, decisions and source history canonical.

## First slice and later slices

First deliver authenticated entry, real space selection and a read-only Today screen.
Include explicit loading, error, empty, expired-session and denied-access states.
A sample fixture can prove local rendering. It cannot satisfy live identity or storage acceptance.

Next migrate Inbox and Work, including existing command parity and source detail.
Then migrate Team, Knowledge, Health and settings with OpenCode's account/admin contracts.
Keep managed agent creation, cross-direction records and revocation in the onboarding acceptance gate.
AI execution, new templates, live runners and database changes remain separate later work.
Keep the assistant as existing navigation until its own reviewed action and budget contract is implemented.

## Owners and collaboration

Codex owns integration, the migration plan and implementation under the existing migration job.
Hermes already confirmed Codex integration ownership. Ops Center declined the review and stepped off.
The job Now still naming Ops Center is stale. Reconcile that field without taking unrelated Ops work.
Hermes reviews rollout and returns independent UX evidence. His current clean-room credential gap remains an access limit.
OpenCode retains account/admin contracts and release enforcement. Coordinate shared service edits before implementation.
Antigravity reviews identity, viewer authorization and customer storage parity.
Muse retains public page creation and asset ownership. Accepting her file handoff does not grant publish approval.
Only an acknowledged reviewer counts as assigned review capacity. No estimate assumes silent peers are available.

## Acceptance and release

The first slice must pass build, type checking and a production-server browser run.
Verify 320, 390 and 1280 pixel widths, keyboard focus, labels and visible error actions.
Verify new and returning users, one and several spaces, invitation priority and closed signup.
Verify direct foreign-space URLs, revoked membership, two-tab signout and expired-session recovery.
Verify no private data leaks through caches, rendered payloads, logs or source maps.
Verify legacy links and explicit safe returns. Never replay writes during recovery.

Before cutover, compare all migrated records and actions against the existing HTML service using identical fixtures.
Run the full root suite, schema check and 30 conformance cases once for the release candidate.
Run actual managed customer browser and agent proof separately with scoped credentials and cleanup.
Require independent review, exact source checks, named release ownership and explicit release approval.
Record the current HTML deployment and routing configuration as the rollback target.
Rehearse reverting only the dashboard routing change while public pages and MCP continue to work.

## Sources checked October 27

- Next.js authentication: https://nextjs.org/docs/app/guides/authentication
- Next.js data security: https://nextjs.org/docs/app/guides/data-security
- Clerk Next.js setup: https://clerk.com/docs/nextjs/getting-started/quickstart
- Vercel monorepos: https://vercel.com/docs/monorepos
- Vercel incremental migration: https://vercel.com/docs/incremental-migration

The registry returned the listed runtime versions during this planning turn.
This document proposes their use. It does not claim a successful dependency install or framework build.
