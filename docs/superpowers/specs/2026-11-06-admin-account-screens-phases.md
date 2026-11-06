# Admin, dashboard and account screens: phased plan (Nov 6 2026)

Source: gap analysis of the 17 admin canvas boards against the live vanilla app. Mikey approved starting in chat. Each phase is its own PR with tests. Front end first, backend contracts after.

## Rules for every phase
- Keep the homepage, onboarding and visual look. Canvas wins if code and canvas disagree.
- Tests stay green. Verify at 390 px and 1440 px before a PR leaves draft.
- No deploy by claude-code. Antigravity deploys after an approved ask.
- No claim without a check. A screen that cannot read real data shows an empty or unavailable state, never invented numbers.

## Phase 0: done
Phone nav, Inbox centre button, cards, drawer (PR 235). Fleet truth board (PR 242).

## Phase 1: role-gated navigation (front end only)
- One pure model, `nav-model.js`, decides which More links and rail links each viewer sees: operator, owner, admin, member, viewer.
- More page groups: You, Workspace, Admin (operators and workspace managers only).
- Customers stop seeing operator pages (Audit, Waitlist, Activity, Agent keys).
- Done when: tests cover every role, and a customer More page lists no operator link.

## Phase 2: workspace admin tables (front end only)
- Members table with role select, per-space access and approve toggle. Agents table with permission words and spaces.
- Spaces table: name first, slug and copyable ID second, member count, Rename disabled with a reason.
- Invites list with revoke. Uses existing endpoints only.
- Done when: every row action maps to an endpoint that exists today.

## Phase 3: session and Clerk states (front end only)
- Copy for suspended, renewal failed, signed out in another tab, approval after expiry, wrong account.
- Listener for the `lm-account-event` storage write so a sign-out in one tab shows in the others.
- Align sign-in copy to the canvas. Add the agent-setup variant.
- Show name and avatar when `/api/session` returns them.
- Do not touch the keep-alive code from PR 233.

## Phase 4: operator pages consistency
- Settings (operator), Audit, Waitlist, Keys, Connections get the shared page head, view-only labels and the risky-action explanation text.
- Read-only chip stays a chip, never a switch that does nothing.

## Phase 5: data layer for new screens
- Add `read.*` calls with fixtures in `data.js` for sessions, plan and usage, integrations, platform overview. Each returns `{ok, stale, error, data}`.
- Contract version check. Missing version accepted, wrong version rejected.
- Screens ship only when the endpoint exists. Until then the route shows an unavailable state.

## Phase 6: backend-gated screens (after Nov 10)
Order follows backend readiness, owner in brackets.
1. Sessions list and End session [antigravity, auth path].
2. Profile and security rows, Leave workspace [opencode].
3. Space rename, export and import with dry run and approval [opencode].
4. Plan and usage [opencode, plan limits first].
5. Integrations and secrets [opencode, secrets loader first].
6. Platform overview, super admin [antigravity, Clerk flag first].
7. Ask the record, drafting agent [design only until a cost cap and audit entry exist].

## Phase 7: proof and release
- Polar proves each phase in a browser. Muse reviews the look.
- Antigravity deploys. I confirm commit and file status on production after each deploy.
