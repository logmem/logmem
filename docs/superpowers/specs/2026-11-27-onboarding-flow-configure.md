# Onboarding flow — ideation and configure plan (2026-11-27)

Branch: `feat/onboarding-flow`. Mikey's rulings this day: **A then B**, use **Configure** for
onboarding and seeding (pull the configure work in), and Nuance runs as a **separate chat-agent
surface connected to LogMem**. No PR until Mikey says otherwise.

## What exists today (recon, Nov 27)

- **Guided setup, vanilla**: `public/app/setup-guide.js` + `setup-model.js` — four steps
  `Choose agent → Read skills → Connect → Verify`, save/resume in `sessionStorage` per scope
  (`public` / `customer`), sign-in with `returnTo` back into the guide, and a customer-only
  "Check for first entry" verification before "Continue to first task". Copy is guarded by tests
  (`test/agent-discovery.test.mjs`, `test/connect-page.test.mjs`, `test/site.test.mjs`).
- **Waitlist API**: `POST /api/onboarding/waitlist` — rate-limited, email confirmations, plan ladder.
- **Contributor invite flow**: shipped with the dashboard program (admin surface).
- **Next dashboard**: routes `(workspace)/claim`, `select-space`, `space`, `sign-in` — **no onboarding
  route yet**. That is the gap Direction A fills.
- **Walkthrough spec** (2026-10-20): "the step rail is the onboarding rail" — the unification intent.

## Direction A (this branch, first slice)

Bring the four steps into Next as `/onboarding`:

1. `app/onboarding/page.tsx` — server shell, `force-dynamic`, same look tokens as the rest of the app.
2. `app/onboarding/onboarding-client.tsx` — React render of the SAME steps, importing the pure data
   modules from the vanilla site (`setup-model`, `agent-clients`, `start-prompt`, `go-prompt`) so
   prompt copy stays single-source and the guarding tests keep passing. `allowJs` is on.
3. Sign-in chain: `/sign-in?returnTo=/onboarding?step=N&client=…` (parity with vanilla `setupReturn`).
4. Verify step wires the existing first-entry check; customer scope activates when a session exists.

State note: vanilla keeps guide state in `sessionStorage` per origin; the Next app is a different
origin (`app.logmem.si` vs `logmem.si`), so first slice keeps its own state and Direction B moves
progress to the account (server-side) where cross-device resume lives.

## Direction B (after A lands)

Onboarding as a **milestone checklist engine**: waitlist → verify email → connect client →
first entry → invite teammate. Server-held progress (account-scoped), surfaces render only "next
action", and the guide steps become the projection. This replaces per-origin `sessionStorage`.

## Configure.dev integration (pulled in from `configure-tech-spike`, done Nov 23)

- **Sandbox proven**: `POST /v1/sandbox/provision` →201 with test keys; `POST /v1/profile/connect`
  → real `connect_url`; `GET /v1/profile` returns the seeded profile (test user, OTP424242).
- **Mapping**: Who ← identity name, role, occupation, company, summary, soul, preferences.
  Partial: projects and connected apps. Not mapped: doing/blocked/next/owner/stage (those stay
  LogMem-native). Log ← one-time import of dated memories.
- **Effort**: ~7 working days (6–9) for one engineer: OIDC/key wiring0.5d, connect + return routes1d,
  mapper to Who + Brief seed + import log + PII filter + tests1.5d, signed idempotent webhook rest.
- **Gate**: no real client data until Configure answers the7 privacy questions (claude's memo).
- **Fit**: Configure's Connect becomes the **Connect step's engine** in Direction A, and its profile
  read becomes the **seeding source** for Direction B's first milestone (profile pre-filled instead
  of an empty Who). The hosted OTP page needs a person (open).

## Nuance (separate surface)

Nuance runs as its own chat-agent surface connected to LogMem — not part of this rail. Its
credential path is already live: `NUANCE_API_KEY` in Infisical `/Nuance-Labs`, read-scoped token
installed on the openclw box (probe READ_OK). Tracked as its own job once we define the surface
shape (who hosts the chat agent, which LogMem identity it wears).

## Sequencing

1. **A** on this branch (scaffold now) → review → PR when Mikey says.
2. Configure Connect wired into the Connect step (needs the7 privacy answers first).
3. **B** milestones + account-scoped progress.
4. Nuance surface job opened separately.
