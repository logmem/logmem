# Next.js and Vercel Dashboard Implementation Plan

> **For agentic workers:** Execute one approved milestone at a time. Use the named files and gates below.

**Goal:** Move the approved HTML cockpit into a tenant-aware Next.js dashboard with useful, bounded AI actions.

**Architecture:** Keep LogMem's storage, coordination and authorization contracts. Build the dashboard in `apps/dashboard` and migrate routes incrementally. Render the shell and authorized initial data on the server. Use client components for drawers, forms and streaming results.

**Tech Stack:** Next.js App Router, TypeScript, React, Clerk, LogMem design tokens, existing LogMem server services and Vercel.

**Spec:** `docs/superpowers/specs/2026-10-24-dashboard-cockpit-html-design.md`

## Global constraints

- White is the default. Preserve Sage, Sand and Midnight.
- Preserve the approved Today, Inbox, Work, Team, Knowledge and Health layout.
- Reuse canonical requests, original deadlines, decisions and source discussions.
- Resolve workspace membership on the server for every read and mutation.
- Keep private server configuration out of browser bundles.
- Keep unknown usage unknown and incomplete coverage visible.
- Preserve the existing MCP package and root API deployment during migration.
- Keep public signup closed until customer storage and two-identity verification pass.
- Do not add automatic paid code reviews or model calls on page refresh.
- Keep long-lived agent work behind the existing executor boundary.
- New projects, DNS changes and paid service changes require their existing action approvals.

## Review focus

1. A delayed response must not appear after a workspace switch.
2. A recipient mismatch must not display answer controls or grant server authorization.
3. Retries must reuse action identity and avoid duplicate comments or actions.
4. Missing providers must not become healthy status, zero spend or working run controls.
5. A failed rollout must preserve access to the current HTML dashboard.

## Fleet responsibilities

These are proposed delivery boundaries. A posted handoff does not prove acceptance.

| Lane | Proposed owner | First deliverable | Dependency |
| --- | --- | --- | --- |
| Integration and cockpit | Codex | Next shell matching the HTML baseline | HTML release |
| Fleet coordination and rollout | Hermes | Scope conflicts, GitHub App access and release checklist | Plan review |
| Clerk, tenancy and customer setup | Antigravity | Storage receipt and protected two-user login proof | Approved storage access |
| Backend action and AI contract | OpenCode | Scoped tool boundary and cost admission review | Existing bridge P1 and P2 take priority |
| Coordination semantics | Ops Center | Rolling deadline and three-run acceptance cases | Canonical coordination API |

Only the active milestone receives implementation capacity. Review requests do not authorize duplicate builds.

## Milestone 1: Protected Next shell

**Owner:** Codex. **Reviewer:** Hermes.

**Files:** `apps/dashboard/package.json`, `next.config.ts`, `app/layout.tsx`, `app/(workspace)/layout.tsx`, `components/workspace-shell.tsx`, `components/theme-picker.tsx`, `styles/tokens.css`.

**Interfaces:** Shell receives authorized workspace name, selected space and viewer permissions. Theme values remain `white | sage | sand | midnight`.

- [ ] Write browser cases for all six destinations, theme persistence and 320-pixel navigation.
- [ ] Port the approved shell and existing fonts. Use shared semantic tokens.
- [ ] Create a protected preview without changing production routing.
- [ ] Compare phone and desktop captures against the released HTML baseline.
- [ ] Commit the shell only after its browser checks pass.

**Gate:** All destinations render and switch themes. No real AI calls or new storage services.

## Milestone 2: Customer identity and space isolation

**Owner:** Antigravity. **Reviewer:** Codex.

**Files:** `apps/dashboard/lib/server/viewer.ts`, `app/sign-in/[[...sign-in]]/page.tsx`, `app/(workspace)/select-space/page.tsx`, and existing `src/http/viewer.mjs` service adapters.

**Interface:** `resolveDashboardViewer({workspaceId, spaceId, action})` returns the current person, permissions and authorized server service context. It accepts no caller-supplied Redis credential.

- [ ] Write two-identity tests for direct URLs, revoked membership and delayed space responses.
- [ ] Adapt existing Clerk verification and workspace authorization without a second permission model.
- [ ] Verify sign-in, signout, invitation recovery and space creation against dedicated customer storage.
- [ ] Record the protected preview URL, source SHA and test identities without credentials.

**Gate:** Cross-space reads and writes fail. Customer signup stays closed until this gate passes.

## Milestone 3: Today, Inbox and work details

**Owner:** Codex. **Reviewer:** Ops Center for coordination, Antigravity for viewer authorization.

**Files:** `app/(workspace)/today/page.tsx`, `inbox/page.tsx`, `work/page.tsx`, `work/[id]/page.tsx`, `components/work-detail.tsx`, `lib/server/logmem.ts`, `app/api/interactions/route.ts`.

**Interfaces:** Reuse `buildView`, existing coordination queue pagination, and existing interaction command validation. Browser mutations send target, action and stable request ID. The server derives the person and permitted namespace.

- [ ] Pin canonical queue parity against shared fixtures before implementing the new UI.
- [ ] Port personal requests, source comments, nudges and reassignment.
- [ ] Verify rolling 24-hour deadlines survive nudges and retain source history after reassignment.
- [ ] Verify viewer and recipient restrictions in both UI and server tests.
- [ ] Verify retry behavior and stale workspace responses.
- [ ] Add client handling for old `/app#/...` links that sends users to the equivalent new route.

**Gate:** The same records and outcomes appear in HTML and Next. No duplicate authoritative queue.

## Milestone 4: Knowledge, Team, Health and templates

**Owner:** Codex. **Reviewers:** Hermes and Ops Center.

**Files:** `app/(workspace)/knowledge/page.tsx`, `team/page.tsx`, `health/page.tsx`, `lib/templates.ts`, `components/receipt-calendar.tsx`.

**Interfaces:** Templates configure labels, stages and starter records. They do not alter storage authorization or shared record types.

- [ ] Port decisions and source discussions with clear ownership and history.
- [ ] Port morning, midday and closeout receipts with historical date selection.
- [ ] Add provider evidence adapters with timestamps, remaining limits and unknown states.
- [ ] Validate solo operator, developer, trades, restaurant and sales templates in isolated sample spaces.
- [ ] Show execution controls only when a verified runner and enforceable budget exist.

**Gate:** Missing data stays visible. Every summary can reach its source.

## Milestone 5: AI assistance with bounded actions

**Driver:** Codex. **Backend reviewer:** OpenCode after the bridge priority work.

**Files:** `app/api/assistant/route.ts`, `lib/server/assistant-tools.ts`, `lib/server/assistant-budget.ts`, `components/assistant-panel.tsx`, `components/action-proposal.tsx`.

**Interfaces:** A request contains the selected work reference and user intent. The server retrieves authorized context. A proposal carries an exact action, source references, scope, expiry and action identity. Approval must pass the existing server decision boundary.

- [ ] Start with user-triggered summaries, source-backed answers and draft plans.
- [ ] Test budget denial, missing providers, cancellation and cross-space tool arguments.
- [ ] Add proposal review before any mutation. Revalidate membership and action version at execution.
- [ ] Record token use, provider cost evidence and action outcomes without secrets.
- [ ] Add per-workspace admission caps and concurrency limits before background execution.

**Gate:** No model request starts on refresh. No tool action bypasses permission, approval or budget checks.

## Milestone 6: Vercel rollout and rollback

**Coordinator:** Hermes. **Release owner:** Codex. **Provider owner:** Antigravity.

**Files:** `apps/dashboard/vercel.json` only if needed, deployment scripts, `docs/runbooks/dashboard-rollout.md`.

- [ ] Repair GitHub App access to `logmem/logmem` and verify one commit reaches its expected preview.
- [ ] Configure the dashboard project root and required preview environment names. Never copy fleet credentials into customer storage.
- [ ] Keep the current public homepage and MCP routes available.
- [ ] Run route parity, identity, source interaction, performance and accessibility checks on the protected preview.
- [ ] Promote only after all gates pass and the release action has authorization.
- [ ] Record aliases, exact source SHA and rollback deployment.
- [ ] Apply the existing domain plan in a separate DNS change after approval.

**Gate:** Rollback restores the HTML dashboard. Failed customer checks never open public signup.

## Verification cadence and usage control

Run focused checks during a change. Run the full repository and relevant browser suites once before release.
Re-run only after a new change or failure. Wait for CI at most once per minute.
Do not keep idle agents, duplicate status polling or automatic model summaries running.

## Current release blockers

Dedicated customer Redis credentials and real Clerk identity checks remain unverified.
Temporary root access to customer service 968026 still lacks explicit approval.
The current HTML assistant is navigation only. AI proposal and execution remain future milestones.

## Documentation references

- [Next.js server and client components](https://nextjs.org/docs/app/getting-started/server-and-client-components)
- [Vercel monorepos and project roots](https://vercel.com/docs/monorepos)
- [AI SDK tools and approval flow](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
