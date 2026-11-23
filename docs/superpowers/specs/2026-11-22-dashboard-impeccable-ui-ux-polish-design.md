# LogMem Dashboard UI/UX Polish & Shared Design Contract

- **Status:** Direction approved in 2026-11-22 Superpowers brainstorm; written spec awaits operator review.
- **Owner:** `agent:antigravity`
- **Job:** `job:dashboard-impeccable-ui-ux-polish` (plan: `ux-enhancement`, track: `Dashboard`)
- **Base revision:** `origin/main` at `613f722` (live on `logmem.si` and `app.logmem.si`)
- **Branch / worktree:** `antigravity/dashboard-impeccable-ui-ux-polish` (`/Users/michaelshaw/clawd/projects/logmem-wt/antigravity-dashboard-polish`)
- **Governing references:**
  - `LogMem product design.html` (24-board v0.2 Action Map + App Look canvas: `page_16` components, `page_17` rail, `page_18` UX audit, `page_19`/`page_22` Brief, `page_20` Inbox, `page_23` Chat, `page_05`–`page_15` core views)
  - `public/ds/tokens/logmem.css` and `public/ds/components/bundle.css`
  - Live vanilla dashboard (`public/app.html`, `public/app.css`, `public/app/*`)
  - Live Next.js dashboard (`apps/dashboard/*`)
  - `open-design` Nov 22 trend audit (`job:design-trend-scan-202611`): keep `Schibsted Grotesk` + `IBM Plex`, keep light default, protect the shared-log look, accent-level motion only.

---

## 1. Outcome & Design Direction

Both LogMem dashboards (`logmem.si/app` vanilla and `app.logmem.si` Next.js) share **one normative design contract (`DESIGN.md`)**, **one semantic token and v0.2 component layer (`public/ds/`)**, **one unified Brief-first shell**, and **zero stub workspace routes**.

### Impeccable Operate Mode — Instrument Precision

Polish is refinement, never concealed redesign. Both dashboards are **Operate** surfaces where scanability, earned familiarity, and component consistency outrank decorative flair:

1. **Tokens only (zero hardcoded hex):** Every workspace surface, border, text role, focus ring, status indicator, and elevation consumes CSS custom properties from `public/ds/tokens/logmem.css`. No raw `#hex` literals in workspace components.
2. **Light default with full dark parity:** Light (`--bg: #F4F6F5`, `--surface: #FFFFFF`, `--text: #121A19`, `--brand: #0E6863`) is the default; dark (`--bg: #0C1211`, `--surface: #121A19`, `--surface-raised: #19231F`, `--text: #E9EEEC`, `--brand: #4FC3B8`) propagates automatically via `data-theme` and `prefers-color-scheme`.
3. **Typography:** `Schibsted Grotesk` (600/800) for page and brand headings; `IBM Plex Sans` (400/500/600) for all UI labels, body copy, and controls; `IBM Plex Mono` (400/500) for timestamps, IDs, counts (`tabular-nums`), and env/config flags. Fixed `rem`/`px` scale (no fluid `clamp()` headings in Operate UI).
4. **Density & geometry:** Comfortable default (`--control-h: 36px`, `--row-h: 44px`, `--pad-panel: 20px`) with opt-in `[data-density="compact"]` (`28px` / `32px` / `16px`). Crisp `1px` `--border` panels, `--radius-md: 6px` for cards/inputs/buttons, `--radius-pill: 999px` for chips/badges, `--shadow-1` lift only on interactive tiles and overlays.
5. **Strict semantic color roles:**
   - `--brand` (teal): primary actions and active navigation only.
   - `--decision` (violet `#6B3FA0` / `#C6A0F0`): human approval gates (`Approve`, decision tags) only.
   - `--focus` (`#2453D6` / `#86A6FF`): visible `2px` keyboard focus outlines.
   - `--viz-1` through `--viz-6`: the 6 entry-kind groups (Work, Handoff, Signal, Decision, Error, System) — never arbitrary per-kind colors.
   - Every status state carries a word alongside color.
6. **Restrained motion:** `--duration-instant` (`80ms`), `--duration-fast` (`140ms`), `--duration-base` (`200ms`), `--duration-slow` (`320ms`) with `--ease-standard`. Zeroed under `prefers-reduced-motion: reduce` (including holding the Chat state orb still).

---

## 2. Unified Shell & Navigation Contract

Approved direction: **Unified "Brief-first" Shell** across both codebases — one name per place (audit `G6`), zero breaking URL renames.

### Desktop Rail (`--rail-width: 232px`, sticky)

1. **Header:** LogMem brand lockup + Space switcher (`madez ▾`) showing the active space name.
2. **Primary group:**
   - **Brief** (badge: open `needs_you` count) — Vanilla `#/home`, Next.js `/space/[space]/today` (label unified `Today → Brief`; URL preserved)
   - **Inbox** (badge: open handoff count) — Vanilla `#/queue`, Next.js `/space/[space]/inbox`
   - **Activity** — Vanilla `#/activity`, Next.js `/space/[space]/activity`
   - **Chat** — Vanilla `#/chat`, Next.js `/space/[space]/chat` (also registered in `SPACE_PAGES` in `apps/dashboard/lib/server/routes.mjs`)
   - **Work** — Vanilla `#/work`, Next.js `/space/[space]/work`
   - **Agents** — Vanilla `#/agents` (label unified `Team → Agents`), Next.js `/space/[space]/agents`
3. **Secondary / More group (role-gated, separated by a hairline):**
   - Next.js: `Schedule` (`/space/[space]/schedule`), `Agent access` (`/space/[space]/access`).
   - Vanilla: `Decisions` (badge), `Knowledge`, `Health`, `Fleet truth`, `Log`, `Recall`, plus `Settings`/`Account`, `Agent access` (managers), and operator-only `Audit` & `Waitlist`.
4. **Footer:** User/account control (Clerk `UserButton` in Next.js; viewer/theme control in vanilla) and compact storage/compatibility status indicator where relevant.

### Mobile Chrome (`< 768px`)

- Fixed bottom bar (`height: 56px`, `padding-bottom: env(safe-area-inset-bottom)`) with **5 primary tabs**: **Brief**, **Inbox**, **Chat**, **Work**, **More** (`min-width: 44px`, `min-height: 44px` touch targets).
- Replaces Next.js's current 8-item horizontal scrolling bottom bar (`overflow-x-auto`) with an accessible `More` sheet/drawer holding `Activity`, `Agents`, `Schedule`, `Agent access`, and space/account actions.
- Every active link sets `aria-current="page"`.

---

## 3. Delivery Architecture — Token-First Shared System in 4 Bounded Waves

### Wave 0 — Normative `DESIGN.md` & Shared v0.2 Component Contract (`public/ds/`)

1. **Create repo-root `DESIGN.md`:**
   - Structured with `create-design-md` YAML frontmatter (`colors`, `typography`, `rounded`, `spacing`), `## Overview`, `## Colors`, `## Themes` (exact light/dark table), `## Typography`, `## Layout`, `## Elevation & Depth`, `## Shapes`, `## Components`, and `## Do's and Don'ts`.
   - Validated via `npx @google/design.md lint DESIGN.md` and `npx @google/design.md export --format css-tailwind DESIGN.md`.
2. **Extend `public/ds/components/bundle.css` with v0.2 primitives** (from `LogMem product design.html` `page_16` & `page_23`):
   - `.lm-page-header` (G6): one page title matching nav label + subtitle/timestamp + right-aligned action slot.
   - `.lm-status-strip` (G1): ~40px single-line dismissible status bar replacing repeated tall banners.
   - `.lm-stat-tile` (G5/G12): interactive linked KPI tile with `tabular-nums`, muted zero state (`.is-zero`), and subtitle (`of N open`).
   - `.lm-copy-id` (G9): middle-truncated monospace ID pill (`handoffPr…kit`), full value on hover/title, click-to-copy with `Copied` feedback; raw IDs never printed inline on card headers.
   - `.lm-age-chip` (I1/I6): filter chip row (`All`, `Due soon`, `Overdue`, `Over 48 h`) where zero-count buckets render `disabled` rather than hidden.
   - `.lm-kind-chip`: 6-group colored badges mapped strictly to `--viz-1`..`--viz-6` (`work`, `handoff`, `signal`, `decision`, `error`, `system`), unknown kinds in neutral `--surface-sunken`.
   - `.lm-entry-row`: time + `KindChip` + agent byline + verbatim summary + muted provenance line (`where · trail · origin · via`).
   - `.lm-readonly-flag` (S3): status chip + environment variable hint; never rendered as a toggle switch.
   - `.lm-orb` & `.lm-cite-chip` (Chat `page_23`): 20px 6-state agent orb (`working`, `reasoning`, `searching`, `retrying`, `compacting`, `waiting`) paired with status text, animated smoothly and held still under `prefers-reduced-motion`; inline clickable `[1]` citation chip.
3. **Wire Tailwind v4 theme mapping in `apps/dashboard/app/globals.css`:**
   - Import `public/ds/tokens/logmem.css` and `public/ds/components/bundle.css`, and map `@theme` color/font/radius variables to `var(--*)` so Tailwind classes and custom components stay 100% token-driven.

### Wave 1 — Vanilla Dashboard Polish (`public/app/` & `public/app.css`)

Target: every live page at `logmem.si/app`, preserving PR #308's Activity older-page pagination (`public/app/log-model.js`, `public/app/views.js`) and all existing viewer/role permissions.

| Surface | Files | Polish Deliverables |
|---|---|---|
| Shell & Nav | `nav-model.js`, `shell.js`, `app.css`, `theme-controls.css` | Unify `Team → Agents` (G6); consistent `PageHeader`; 5-tab mobile bar + `More`; visible `--focus` rings; prune duplicate hex overrides in `app.css` so dark theme passes AA contrast everywhere. |
| Brief | `brief-view.js`, `today-components.js` | 40px dismissible `StatusStrip` (G1); linked `StatTileLink` strip with muted zeros and additive needs-you totals (G5/G12); crisp Agent shift table. |
| Inbox & Drawers | `interactions.js`, `drawer.js`, `dispatch-components.js` | Oldest-first queue (I1/I6), disabled-not-hidden `AgeBucketChips`, `CopyId` pills (G9), inline actions, sticky drawer footer with secondary `Can't do` (NP3), keyboard Escape + focus return. |
| Chat | `chat-view.js`, `assistant-widget.js` | 3-state craft: Empty prompt chips, Working 20px `ChatStateOrb` + collapsible tool trace, Answered inline `[1]` citation chips + violet approval gate framing. |
| Work & Plans | `views.js`, `plans-view.js`, `cards.js`, `job-detail-components.js` | Fix vertical age text (W1), allow title wrap + trim descriptions (W2), 6-group `KindChip`, `CopyId` pills. |
| Activity / Log | `log-components.js`, `log-model.js`, `views.js` | `EntryRow` provenance line (`where · trail · origin · via`), shift boundaries, Recap cards, preserve PR #308 pagination controls with proper disabled/loading states. |
| Agents, Health, Knowledge, Decisions, Fleet truth | `profile-components.js`, `health-components.js`, `decisions-view.js`, `fleet-truth-view.js` | Shared `PageHeader`, `ScorecardStrip` (word + color, missing = fail), honest empty/error panels, tabular numerals. |
| Settings, Account, Access, Audit, Waitlist | `account.js`, `access-view.js`, `setup-guide.js` | `ReadOnlyFlag` chips replacing fake switches (S3), clean multi-client `ConnectSnippet`, preserve operator-only gating. |

### Wave 2 — Next.js Shared React Primitives & Populated Views (`apps/dashboard/`)

1. **Create `apps/dashboard/components/ui/`** — small, focused, token-backed components (`zero` hardcoded hex):
   - `page-header.tsx`, `status-strip.tsx`, `stat-tile.tsx`, `copy-id.tsx`, `age-bucket-chips.tsx`, `kind-chip.tsx`, `entry-row.tsx`, `readonly-flag.tsx`, `chat-state-orb.tsx`, `state-panel.tsx` (loading skeleton, instructive empty, `role="alert"` error).
2. **Route & Shell updates:**
   - Register `'chat'` in `SPACE_PAGES` in `apps/dashboard/lib/server/routes.mjs`.
   - Refactor `apps/dashboard/app/(workspace)/space/[space]/layout.tsx` and `components/nav-rail.tsx` to use CSS vars, label `Today → Brief`, add `aria-current="page"`, live Brief/Inbox count badges, and 5-tab mobile bottom bar + accessible `More` sheet.
3. **Polish populated pages & overlays:**
   - `today/page.tsx` (Brief): `PageHeader`, dismissible `StatusStrip`, linked `StatTileLink` strip (clicking routes to Inbox/Work/Agents), muted zeros, `CopyId` on job refs, honest error panel.
   - `components/inbox-view.tsx` & `components/decision-drawer.tsx`: `AgeBucketChips` (empty disabled), `CopyId`, sticky drawer footer with secondary `Can't do` (NP3), violet approval button, full keyboard/focus handling, zero hex literals.
   - `chat/page.tsx` & `components/chat-panel.tsx`: 20px `ChatStateOrb` during streaming (`Reading this space…`), inline citation chip styling, clean approval block using `--decision`, zero hex literals.
   - `select-space/page.tsx`, `sign-in/[[...sign-in]]/page.tsx`, `space/denied/page.tsx`, `error.tsx`, `app/layout.tsx`: align spacing, typography, focus rings, and dark-mode contrast to `DESIGN.md`.

### Wave 3 — Wire the 5 Next.js Stub Routes on Existing Jailed `buildView`

All 5 routes replace the 10-line `SpacePage` placeholder with real server-rendered pages using the **exact same jailed in-process pattern** as `apps/dashboard/lib/server/today.ts` and `inbox.ts`:

```text
requireSpace(space, 'read') → buildView(viewer.redis, viewer.namespace, what, params, now) → pure lib/*-model.mjs → components/ui/*
```

**Security boundary:** `apps/dashboard/lib/server/viewer.mjs` and `auth.ts` are NOT modified. No new credentials, no HTTP hops, no caller-supplied Redis params.

| Route | Server Loader (`lib/server/`) | `buildView` Call | Pure Model (`lib/`) | Rendered View & States |
|---|---|---|---|---|
| `/space/[space]/work` | `work.ts` | `buildView(..., 'jobs')` | `work-model.mjs` | Stage filter chips (`All`, `Active`, `Blocked`, `Open`, `Done`), wrapped job titles (W2), horizontal age badge (W1), `CopyId`, owner + plan metadata, empty teaches `logmem_assign`. |
| `/space/[space]/agents` | `agents.ts` | `buildView(..., 'agents')` | `agents-model.mjs` | Shift status table (`Agent · Now · On shift / idle / ended`), last Recap excerpt, connected vs working clarity, empty teaches `logmem_start`. |
| `/space/[space]/activity` | `activity.ts` | `buildView(..., 'log', { limit: 200 })` | `activity-model.mjs` | Newest-first `EntryRow` list, 6-group `KindChip` filter bar, verbatim summaries + provenance line (`where · trail · origin · via`), shift boundaries. |
| `/space/[space]/schedule` | `schedule.ts` | `buildView(..., 'agents')` + `buildView(..., 'jobs')` | `schedule-model.mjs` | Active/recent shift timeline + jobs with explicit due/milestone dates sorted chronologically; honest empty state when no shifts or due dates exist (never invents cron schedules). |
| `/space/[space]/access` | `access.ts` | `buildView(..., 'settings')` | `access-model.mjs` | `ReadOnlyFlag` status chips (S3: Space ID, Mirror status, ACMI compatibility, storage backend health) + multi-client `ConnectSnippet` tabs (`Claude Code`, `Codex`, `Cursor`, `Claude Web`) using redacted placeholders — never prints tokens or secrets. |

Each route also ships a matching `loading.tsx` skeleton (exact panel geometry, zero layout shift) and renders `StatePanel(variant="error", role="alert")` when `unavailable: true` — **never** mistaking a backend read failure for an empty space.

---

## 4. Error Handling & Edge Cases

- **Unavailable ≠ empty:** Every server loader (`today.ts`, `inbox.ts`, `work.ts`, `agents.ts`, `activity.ts`, `schedule.ts`, `access.ts`) catches storage errors outside `requireSpace` (so Clerk sign-in / membership redirects propagate untouched) and returns `{ unavailable: true }`, rendered with `role="alert"` and a reload action.
- **Long & missing content:** Job titles wrap up to 2 lines; descriptions clamp cleanly; IDs truncate in the middle via `CopyId`; missing owners/dates render explicit neutral labels (`Unassigned`, `No due date`) rather than blank gaps.
- **Role & permission safety:** Read-only settings never look editable (`ReadOnlyFlag`); operator-only vanilla routes (`Audit`, `Waitlist`) remain hidden from customers; zero secrets or raw tokens ever appear in markup or `ConnectSnippet`.
- **Interactive state completeness:** Every control implements default, hover, `focus-visible`, active, disabled, loading, and error states.

---

## 5. Verification & Fleet Coordination

### Automated Checks (Required Before Every Wave PR)

1. **Wave 0:** `npx @google/design.md lint DESIGN.md` and `npx @google/design.md export --format css-tailwind DESIGN.md` pass with all populated token families emitted.
2. **Wave 1:** Root `npm test` passes (including `nav-model`, `log-model`, and UI unit tests); no regressions to PR #308 Activity pagination.
3. **Wave 2:** Unit tests cover `routes.mjs` (verifying `'chat'` in `SPACE_PAGES` and `safeReturnTo`), zero-hex grep check passes across `apps/dashboard/app/(workspace)/` and `apps/dashboard/components/ui/`, `apps/dashboard` `tsc --noEmit` and `next build` succeed.
4. **Wave 3:** Unit tests for all 5 pure models (`work-model.mjs`, `agents-model.mjs`, `activity-model.mjs`, `schedule-model.mjs`, `access-model.mjs`), including empty, populated, malformed, and long-content cases; `apps/dashboard` `tsc --noEmit` and `next build` succeed.

### Visual & Accessibility QA Gate (Before Ship)

- Inspect rendered vanilla (`public/app`) and Next.js (`apps/dashboard`) at **`1280px`** (desktop), **`768px`** (tablet), and **`320px` / `390px`** (phone) in **both Light and Dark themes**.
- Verify keyboard-only traversal (`Tab`, `Shift+Tab`, `Enter`, `Space`, `Escape`) across rail, mobile `More` sheet, `Inbox` age chips, `DecisionDrawer`, `CopyId`, and `ChatPanel`.
- Confirm zero horizontal overflow at `320px`, zero console errors, WCAG AA contrast on all text/controls, and reduced-motion stillness on `ChatStateOrb`.

### Fleet Coordination & Release Rules

- Coordinate with `agent:claude-code` on `job:dashboard-nextjs-vercel-migration` and `channel:agent-coordination` before opening Wave 3 PRs.
- Deliver as **4 independent, reviewable PRs** (Wave 0 → Wave 1 → Wave 2 → Wave 3).
- **No merge, no deploy, no secret changes** without explicit operator GO.
