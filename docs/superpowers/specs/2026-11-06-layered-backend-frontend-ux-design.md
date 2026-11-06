# Layered backend, front end and UX plan (approved by Mikey in chat, Nov 6 2026)

Goal: enhance the UX of the vanilla app without changing what Mikey likes. Build the backend contracts first, put one data layer under the front end, then simplify screens.

## Keep (do not change)
- Homepage, onboarding, visual look (tokens, home-theme, look.css, orb).
- Atomic workspace commit, roles model, hashed agent keys, sealed OAuth records, ask and approve gate.

## Decisions (Mikey, Nov 6)
1. Antigravity owns releases and deploys.
2. Nav and option-limit work goes into p1 (PR 235) now. It is UX only.
3. Vercel Web Analytics is enabled on Mikey's side. Use real numbers for later ranking.
4. Secrets: self-hosted Infisical on Elestio. A central loader comes first, so the vault is a swap behind one module.
5. Free plan limit: 1 space.

## Layer 0: safety floor (antigravity, opencode)
- Release owner and token: antigravity. Deploy step moves from laptop to an environment-secret workflow.
- General API rate limit middleware, with limits per route class.
- Complete the old bridge token rotation and scan git history.
- OAuth KEK key id with old-key fallback.
- Space export and backup path (JSON zip, dry run, approval).

## Layer 1: backend contracts (opencode, antigravity, grok)
- Plan enforcement: Free = 1 space. Read limits from one plans source, not a default of 10.
- Space rename and archive. Plan change path.
- Admin routes use the live role check, not the cookie alone. Remove the password-hash fallback for the cookie secret. Expire the break-glass token.
- Fail closed on suspension check errors.
- `src/lib/secrets.mjs`: one loader for secrets (names, source, last rotated). Later backed by self-hosted Infisical on Elestio. Standing up Infisical costs money and needs Mikey's go.
- `/api/integrations`: list, status, test, last error. Plus usage and billing read.

## Layer 2: front-end foundation (claude-code)
- `public/app/data.js` with `read.*` and `write.*`. Each returns `{ok, stale, error, data}` with defaults. No raw status codes in views.
- `load()` wrapper, `KEYS` registry, contract version check, fixture test in test/.
- Shared primitives for filter pills, section headings and note inputs.
- Loading, empty and error states for every route. One failed call must not replace the page.
- Fix unguarded field access (views.js 46, 48, 71, 84, 100, 221; drawer.js 108-110).

## Layer 3: UX on the foundation (claude-code, in PR 235)
- Phone bottom bar, five tabs: Today, Work, Inbox (centre), Team, More. Inbox sits in the middle because Needs you is the main action. More holds Knowledge, Health, Settings, Audit, Integrations, Sign out (`pages.more` exists, unlinked).
- Caps: header 4 controls. Cards show 3 actions, the rest in a menu. Today shows at most 7 blocks. Nothing shows more than 5 top-level options.
- Touch targets at least 44 px. Inputs 16 px.
- Verify at 390 px and 1440 px. Polar proves it in a browser after deploy.

## Layer 4: new surfaces (after Nov 10)
- Integrations and secrets screen on /api/integrations.
- Plan and usage. Spaces export and import. Built-in drafting agent (below).

## Built-in drafting agent (design only)
Needs: a model route and client, an ask-only key scope, a draft state for asks, a fixed read-only tool allowlist, a cost cap and a model-call audit entry. A person sends every ask. It never runs an irreversible action.

## Lanes
- claude-code: layers 2 and 3.
- opencode: layer 1 organization, plan limits, spaces, secrets loader.
- antigravity: releases, deploys, rate limit rules, auth hardening.
- grok: integrations status feed, fleet-truth seed.
- codex: review (confirm active).
- polar: browser proof per layer.
- muse: look review.

## Acceptance
- Tests stay green. Each layer ships as its own PR with tests.
- No deploy without an approved ask. No secret in any entry or file.
- Mockups and canvas stay the design source. If code and canvas disagree, canvas wins until a person changes it.
