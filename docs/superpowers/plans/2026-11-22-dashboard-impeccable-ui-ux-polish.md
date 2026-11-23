# LogMem Dashboard Impeccable UI/UX Polish Implementation Plan

> **For agentic workers:** Execute one bounded wave at a time. Load `~/.gemini/config/skills/impeccable/reference/craft-floor.md` immediately before the first UI edit in every wave. Every wave lands as its own reviewable PR — zero merges, deploys, or secret changes without explicit operator GO.

**Goal:** Establish one normative `DESIGN.md` and v0.2 component contract drawn from `LogMem product design.html` and the live app, polish every vanilla (`public/app/`) and Next.js (`apps/dashboard/`) dashboard page to the Impeccable Operate **Instrument Precision** bar, and wire all 5 Next.js stub routes (`work`, `agents`, `activity`, `schedule`, `access`) onto the existing jailed in-process `buildView` layer.

**Architecture:** Token-first shared system in 4 bounded waves. `public/ds/tokens/logmem.css` and `public/ds/components/bundle.css` remain the single CSS source of truth consumed directly by vanilla `public/app/` and imported into Next.js `apps/dashboard/app/globals.css` (mapped via Tailwind v4 `@theme` to `var(--*)`). Next.js workspace routes consume typed React primitives in `apps/dashboard/components/ui/` with zero hardcoded hex literals, and Wave 3 routes load data through `requireSpace(space, 'read') → buildView(viewer.redis, viewer.namespace, what) → pure lib/*-model.mjs` without touching `viewer.mjs` or `auth.ts`.

**Tech Stack:** CSS custom properties, Vanilla ES modules (`public/app/`), Next.js App Router + React 19 + TypeScript + Tailwind v4 (`apps/dashboard/`), Clerk (`requireSpace`), Node test runner (`node --test`), `@google/design.md` linter.

**Spec:** `docs/superpowers/specs/2026-11-22-dashboard-impeccable-ui-ux-polish-design.md`
**LogMem Plan & Lane:** `plan:dashboard-impeccable-polish` (lane: `active`, owner: `agent:antigravity`; parent job `job:dashboard-impeccable-ui-ux-polish` under `ux-enhancement`)
**Branch / Worktree:** `antigravity/dashboard-impeccable-ui-ux-polish` (base `origin/main` `613f722`)

---

## Global Constraints

- **Operate mode refinement, never concealed redesign:** Preserve `Schibsted Grotesk` / `IBM Plex Sans` / `IBM Plex Mono`, light-first default (`#F4F6F5` / `#FFFFFF` / `#0E6863`), full dark parity (`#0C1211` / `#121A19` / `#4FC3B8`), decision violet (`#6B3FA0` / `#C6A0F0`), and real product routes.
- **Zero hardcoded hex in workspace components:** Every workspace file under `apps/dashboard/app/(workspace)/` and `apps/dashboard/components/ui/` uses `var(--*)` or `@theme` semantic classes exclusively.
- **No breaking URL renames:** Next.js `Today → Brief` keeps `/space/[space]/today` working; vanilla `Team → Agents` keeps `#/agents` working; `'chat'` is added to `SPACE_PAGES`.
- **Preserve PR #308:** Keep `public/app/log-model.js` and `public/app/views.js` Activity older-page pagination intact.
- **Auth & storage untouched:** Do not edit `apps/dashboard/lib/server/viewer.mjs` or `apps/dashboard/lib/server/auth.ts`. Never print secrets or raw tokens in `ConnectSnippet` or logs.
- **Honest states:** Unavailable never renders an empty state; every server loader catches read errors outside `requireSpace` and renders `StatePanel(variant="error", role="alert")`.
- **Release gate:** Separate PR per wave. No merge, no deploy, no env/secret mutation without operator GO.

---

## LogMem Plan, Milestones & Job Map

| Wave | Milestone | Job ID | Track | Target Date |
|---|---|---|---|---|
| Wave 0 | `milestone-dash-polish-m0-tokens` | `dash-polish-w0-design-md-and-tokens` | Foundation | 2026-11-24 |
| Wave 1 | `milestone-dash-polish-m1-vanilla` | `dash-polish-w1-vanilla-app` | Vanilla | 2026-11-26 |
| Wave 2 | `milestone-dash-polish-m2-next-ui` | `dash-polish-w2-nextjs-primitives` | Next.js | 2026-11-28 |
| Wave 3 | `milestone-dash-polish-m3-next-routes` | `dash-polish-w3-nextjs-five-routes` | Next.js | 2026-12-01 |

---

## Wave 0 — Normative `DESIGN.md` & Shared v0.2 Component Contract (`dash-polish-w0-design-md-and-tokens`)

**Milestone:** `milestone-dash-polish-m0-tokens`
**Files:**
- Create: `DESIGN.md`
- Modify: `public/ds/components/bundle.css`
- Modify: `apps/dashboard/app/globals.css`
- Test: `test/ds-v02-tokens.test.mjs` (new lightweight contract test verifying CSS custom property & v0.2 primitive classes exist with zero missing vars)

### Tasks

1. **Task 0.1 — Author repo-root `DESIGN.md` (using `create-design-md` schema):**
   - Check installed schema with `npx @google/design.md spec`.
   - Write YAML frontmatter (`version: alpha`, `name: LogMem`, `colors`, `typography`, `rounded`, `spacing`) sourced strictly from `public/ds/tokens/logmem.css`.
   - Write Markdown sections in canonical order: `## Overview`, `## Colors`, `## Themes` (exact light + dark table), `## Typography`, `## Layout`, `## Elevation & Depth`, `## Shapes`, `## Components` (9 v0.2 primitives + shell contract), `## Do's and Don'ts`.
   - Run `npx @google/design.md lint DESIGN.md` and `npx @google/design.md export --format css-tailwind DESIGN.md`; verify every populated category emits cleanly (`--color-*`, `--font-*`, `--text-*`, `--radius-*`, `--spacing-*`).

2. **Task 0.2 — Add 9 v0.2 CSS primitives to `public/ds/components/bundle.css`:**
   - Implement using `var(--*)` only (zero hardcoded hex):
     - `.lm-page-header` (G6: title matching nav + subtitle/meta + actions slot)
     - `.lm-status-strip` (G1: ~40px single-line dismissible strip)
     - `.lm-stat-tile` + `.lm-stat-tile.is-zero` (G5/G12: linked tile, `tabular-nums`, muted zero)
     - `.lm-copy-id` (G9: middle-truncated monospace pill, hover/focus ring, `.is-copied` confirmation)
     - `.lm-age-chip` (disabled-not-hidden zero bucket styling)
     - `.lm-kind-chip[data-group="work|handoff|signal|decision|error|system"]` mapped strictly to `--viz-1`..`--viz-6` + neutral fallback
     - `.lm-entry-row` (time, kind chip, agent, verbatim summary, muted provenance line)
     - `.lm-readonly-flag` (S3: status chip + env key mono hint)
     - `.lm-orb[data-state="working|reasoning|searching|retrying|compacting|waiting"]` (20px orb, smooth pulse/spin, static under `prefers-reduced-motion: reduce`) + `.lm-cite-chip` (`[1]` inline clickable chip).

3. **Task 0.3 — Map Tailwind v4 `@theme` in `apps/dashboard/app/globals.css`:**
   - Import `../../../public/ds/tokens/logmem.css` and `../../../public/ds/components/bundle.css`.
   - Bind `@theme` semantic colors (`--color-bg: var(--bg)`, `--color-surface: var(--surface)`, `--color-surface-raised: var(--surface-raised)`, `--color-surface-sunken: var(--surface-sunken)`, `--color-border: var(--border)`, `--color-border-strong: var(--border-strong)`, `--color-text: var(--text)`, `--color-text-muted: var(--text-muted)`, `--color-text-subtle: var(--text-subtle)`, `--color-brand: var(--brand)`, `--color-brand-hover: var(--brand-hover)`, `--color-brand-subtle: var(--brand-subtle)`, `--color-on-brand: var(--on-brand)`, `--color-focus: var(--focus)`, `--color-decision: var(--decision)`, `--color-decision-subtle: var(--decision-subtle)`, `--color-success/warning/danger/info` + subtle variants) and radii/fonts.

4. **Task 0.4 — Add `test/ds-v02-tokens.test.mjs` & verify Wave 0:**
   - Assert every v0.2 primitive class exists in `public/ds/components/bundle.css` and contains zero raw `#hex` color declarations.
   - Run `node --test test/ds-v02-tokens.test.mjs`, `npm test`, and `cd apps/dashboard && npm run build`.
   - Commit Wave 0 and update `job:dash-polish-w0-design-md-and-tokens`.

---

## Wave 1 — Vanilla Dashboard Polish (`dash-polish-w1-vanilla-app`)

**Milestone:** `milestone-dash-polish-m1-vanilla`
**Pre-edit gate:** Read `~/.gemini/config/skills/impeccable/reference/craft-floor.md`.
**Files:**
- Modify: `public/app/nav-model.js`, `public/app/shell.js`, `public/app.css`, `public/app/theme-controls.css`
- Modify: `public/app/brief-view.js`, `public/app/today-components.js`
- Modify: `public/app/interactions.js`, `public/app/drawer.js`, `public/app/dispatch-components.js`
- Modify: `public/app/chat-view.js`, `public/app/assistant-widget.js`
- Modify: `public/app/views.js`, `public/app/plans-view.js`, `public/app/cards.js`, `public/app/job-detail-components.js`
- Modify: `public/app/log-components.js`, `public/app/profile-components.js`, `public/app/health-components.js`, `public/app/decisions-view.js`, `public/app/fleet-truth-view.js`, `public/app/account.js`, `public/app/access-view.js`
- Test: existing `test/*nav*`, `test/*log*`, `test/*app*` + add unit assertions for `Team → Agents` and 6-group `KindChip` mapping.

### Tasks

1. **Task 1.1 — Shell, Navigation & Dark-Theme Cleanup:**
   - Update `PRIMARY_NAV` in `public/app/nav-model.js`: unify `Team → Agents` (keeping route `'agents'`), update corresponding unit tests.
   - Standardize `PageHeader` across `shell.js` / views so every route shows one title matching its nav label (G6).
   - Ensure mobile bottom bar stays 5 crisp tabs (`Brief`, `Inbox`, `Chat`, `Work`, `More`) with `>=44px` touch targets and keyboard-accessible `More` sheet (`aria-current="page"`, Escape closes, focus returns).
   - Audit `public/app.css` for hardcoded hex overrides that break `[data-theme="dark"]` or `prefers-color-scheme: dark`; replace with `var(--*)` from `logmem.css`.

2. **Task 1.2 — Brief & Inbox Polish (G1, G5, G9, G12, I1/I5/I6, NP3):**
   - Brief (`brief-view.js`, `today-components.js`): adopt `.lm-status-strip` (~40px dismissible, persisted), linked `.lm-stat-tile` strip with muted zeros and additive `Decisions + Tasks + Reviews = Need you` counts, clean Agent shift table.
   - Inbox & Drawer (`interactions.js`, `drawer.js`, `dispatch-components.js`): oldest-first list without auto-scroll jumps, disabled-not-hidden `.lm-age-chip` buckets, `.lm-copy-id` pills (click-to-copy, hover full ID), sticky drawer footer with secondary `Can't do` (NP3) and violet `Approve`.

3. **Task 1.3 — Chat 3-State Polish (`chat-view.js`, `assistant-widget.js`):**
   - Empty state: crisp prompt suggestion chips + read-only/approval guarantee line.
   - Working state: 20px `.lm-orb` paired with live status label + collapsible tool-activity trace.
   - Answered state: inline clickable `.lm-cite-chip` (`[1] [2]`) + violet approval card (`--decision`).

4. **Task 1.4 — Work, Activity/Log, Agents, Health, Decisions, Settings & Access:**
   - Work & Plans (`views.js`, `plans-view.js`, `cards.js`): horizontal age badges (W1), wrapped titles + clamped descriptions (W2), 6-group `.lm-kind-chip`, `.lm-copy-id`.
   - Activity / Log (`log-components.js`, `views.js`): `.lm-entry-row` with `where · trail · origin · via` provenance line, shift boundaries, Recap cards — **preserving PR #308 older-page pagination intact**.
   - Health / Decisions / Agents / Settings / Access: `.lm-readonly-flag` replacing any fake switches (S3), word+color `ScorecardStrip`, clean `ConnectSnippet`.

5. **Task 1.5 — Wave 1 Verification:**
   - Run full root `npm test`.
   - Visually inspect rendered `public/app` at `1280px`, `768px`, and `320px` in Light & Dark, plus keyboard traversal and zero console errors.
   - Commit Wave 1 and update `job:dash-polish-w1-vanilla-app`.

---

## Wave 2 — Next.js Shared Primitives & Populated Pages (`dash-polish-w2-nextjs-primitives`)

**Milestone:** `milestone-dash-polish-m2-next-ui`
**Pre-edit gate:** Re-verify `craft-floor.md` rules; sync branch with `origin/main` if needed.
**Files:**
- Modify: `apps/dashboard/lib/server/routes.mjs` (add `'chat'` to `SPACE_PAGES`)
- Create: `apps/dashboard/components/ui/{page-header,status-strip,stat-tile,copy-id,age-bucket-chips,kind-chip,entry-row,readonly-flag,chat-state-orb,state-panel,index}.tsx`
- Modify: `apps/dashboard/app/layout.tsx`, `apps/dashboard/app/error.tsx`, `apps/dashboard/app/sign-in/[[...sign-in]]/page.tsx`, `apps/dashboard/app/(workspace)/select-space/page.tsx`, `apps/dashboard/app/(workspace)/space/denied/page.tsx`
- Modify: `apps/dashboard/app/(workspace)/space/[space]/layout.tsx`, `components/nav-rail.tsx`, `today/page.tsx`, `components/inbox-view.tsx`, `components/decision-drawer.tsx`, `chat/page.tsx`, `components/chat-panel.tsx`
- Test: `test/dashboard-routes.test.mjs` (verify `'chat'` in `SPACE_PAGES` and `safeReturnTo`), plus zero-hex lint test `test/dashboard-no-raw-hex.test.mjs`.

### Tasks

1. **Task 2.1 — Fix `SPACE_PAGES` & Build `apps/dashboard/components/ui/`:**
   - Add `'chat'` to `SPACE_PAGES` in `apps/dashboard/lib/server/routes.mjs`; add/update unit test verifying `spacePath('madez', 'chat')` and `safeReturnTo('/space/madez/chat')`.
   - Build the 10 typed, accessible React primitives in `apps/dashboard/components/ui/` backed exclusively by `var(--*)` / `@theme` tokens (zero raw `#hex`).

2. **Task 2.2 — Unify `WorkspaceSpaceLayout` & `NavRail`:**
   - Replace every hardcoded `#hex` in `layout.tsx` and `nav-rail.tsx` with semantic tokens.
   - Unify nav label `Today → Brief` (keeping `/space/[space]/today` URL), add `aria-current="page"`, visible `2px` `--focus` outlines, optional Brief/Inbox count badges, and replace the 8-item scrolling mobile bar with a 5-tab bar (`Brief`, `Inbox`, `Chat`, `Work`, `More`) + accessible `More` sheet (`Activity`, `Agents`, `Schedule`, `Agent access`, space switcher, account).

3. **Task 2.3 — Polish Populated Pages (`Brief`, `Inbox`, `DecisionDrawer`, `Chat`, Auth/Chrome):**
   - `today/page.tsx`: use `PageHeader` (`Brief`), `StatusStrip`, linked `StatTileLink` strip (routing to `/inbox`, `/work`, `/agents`), `CopyId`, `StatePanel` for unavailable/empty.
   - `inbox-view.tsx` & `decision-drawer.tsx`: `AgeBucketChips` (disabled zero buckets), `CopyId`, sticky drawer footer with secondary `Can't do` (NP3), violet `Approve` (`--decision`), keyboard focus management, zero hex.
   - `chat/page.tsx` & `chat-panel.tsx`: `PageHeader` (`Chat`), 20px `ChatStateOrb` during streaming (`working` state), inline citation chip styling, `--decision` approval panel, zero hex.
   - `select-space`, `sign-in`, `denied`, `error.tsx`, `app/layout.tsx`: consistent spacing, typography, focus rings, and dark-mode contrast.

4. **Task 2.4 — Wave 2 Verification:**
   - Run `test/dashboard-no-raw-hex.test.mjs` (asserts zero `#([0-9a-fA-F]{3,8})` matches in `apps/dashboard/app/(workspace)/` and `apps/dashboard/components/ui/`).
   - Run root `npm test`, `cd apps/dashboard && npx tsc --noEmit && npm run build`.
   - Visual & keyboard QA at `1280px`, `768px`, and `320px` in Light & Dark.
   - Commit Wave 2 and update `job:dash-polish-w2-nextjs-primitives`.

---

## Wave 3 — Wire the 5 Next.js Stub Routes on Jailed `buildView` (`dash-polish-w3-nextjs-five-routes`)

**Milestone:** `milestone-dash-polish-m3-next-routes`
**Pre-work coordination:** Post notice to `agent:claude-code` on `channel:agent-coordination` referencing `job:dashboard-nextjs-vercel-migration` before editing the 5 route files. Confirm `viewer.mjs` and `auth.ts` stay untouched.

**Files:**
- Create server loaders: `apps/dashboard/lib/server/{work,agents,activity,schedule,access}.ts`
- Create pure view models: `apps/dashboard/lib/{work,agents,activity,schedule,access}-model.mjs`
- Replace stub pages & add skeletons: `apps/dashboard/app/(workspace)/space/[space]/{work,agents,activity,schedule,access}/{page,loading}.tsx`
- Create client filter islands where needed: `apps/dashboard/app/(workspace)/space/[space]/components/{work-view,activity-view,access-view}.tsx`
- Create unit tests: `test/dashboard-{work,agents,activity,schedule,access}-model.test.mjs`

### Tasks

1. **Task 3.1 — Pure View Models & Unit Tests (TDD first):**
   - Implement pure, deterministic view models (`work-model.mjs`, `agents-model.mjs`, `activity-model.mjs`, `schedule-model.mjs`, `access-model.mjs`) handling empty, normal, missing-field, and malformed entries without throwing.
   - Write unit tests for all 5 models covering filtering, sorting, age formatting, kind-group mapping, honest empty/unavailable metadata, and zero-secret redaction in `access-model.mjs`.
   - Run `node --test test/dashboard-*-model.test.mjs` and confirm all pass.

2. **Task 3.2 — Jailed In-Process Server Loaders:**
   - Mirror `today.ts` / `inbox.ts` exactly: call `const viewer = await requireSpace(space, 'read')` outside `try`, then `await buildView(viewer.redis, viewer.namespace, what, params, now)` inside `try`, returning `{ data: null, unavailable: true, now }` on failure.
   - Mapping: `work.ts → 'jobs'`, `agents.ts → 'agents'`, `activity.ts → 'log'` (`limit: 200`), `schedule.ts → 'agents'` + `'jobs'`, `access.ts → 'settings'`.

3. **Task 3.3 — Route Pages (`page.tsx`) & Skeletons (`loading.tsx`):**
   - Replace all 5 `SpacePage` stubs (`work`, `agents`, `activity`, `schedule`, `access`) using Wave 2 `components/ui/*` primitives (`PageHeader`, `KindChip`, `EntryRow`, `CopyId`, `ReadOnlyFlag`, `StatePanel`) + interactive client filter islands for Work (stage chips) and Activity (6-group kind chips) + tabbed `ConnectSnippet` on Access (with redacted placeholders only).
   - Add matching `loading.tsx` skeleton per route with identical container geometry (zero CLS).
   - Delete or retire unused `space-page.tsx` once no route imports it.

4. **Task 3.4 — Final End-to-End QA & Closeout:**
   - Run full root `npm test`, `node --test test/dashboard-*.test.mjs`, `cd apps/dashboard && npx tsc --noEmit && npm run build`, and zero-hex check.
   - Visual + keyboard QA across all 8 Next.js routes and all vanilla pages at `1280px`, `768px`, and `320px` in Light & Dark.
   - Update `job:dash-polish-w3-nextjs-five-routes`, `job:dashboard-impeccable-ui-ux-polish`, and post PR links + QA evidence to `channel:agent-coordination` awaiting operator merge/deploy GO.
