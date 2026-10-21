# Managed users in the web app

Date: 2026-10-20. Plan: `launch`. Owner: Claude Code. Reviewer: Codex. Approver: Mikey.
Status: design approved by Mikey in chat, section by section, on Oct 20. This document records it.

## Goal

Managed users (people with a LogMem account) use the web app at `/app` in the Nov 16 beta.
Dev and test users start on Preview first, never on production data (Mikey picked option A).
Production opens to invited beta users after Preview works.

## Done means

- A dev user and a test user each sign in on the fixed Preview address and see only their own space.
- Each can answer an ask, follow a walkthrough and unblock a job.
- Each can connect an agent (Claude, ChatGPT or Codex) to their Preview space.
- A two-user test proves neither can see or change the other's data, and neither can reach the fleet.

## 1. Who is viewing

Every web app request resolves one viewer before it does anything.

| Viewer | How | Sees | Redis |
| --- | --- | --- | --- |
| Admin (Mikey) | The admin password and the `lm_admin` cookie, as today | The fleet spaces in `LOGMEM_VIEW_SPACES`, plus the admin screens | The fleet Redis |
| Member | A LogMem account through Clerk, then the `lm_member` cookie | Only their own space `t-{id}` | The customer Redis, through the jail |
| Nobody | No valid cookie | The sign-in screen | None |

- Admin screens (Audit, Waitlist and Invites, Settings) are hidden from members, and the server refuses them (403).
- In a member's space the person is always `human:owner`. Agents send asks and tasks to `human:owner`.
  Only the signed-in owner answers them, so answers stay verified without agents knowing account ids.
  Shared team spaces with several people come later.
- Every web API uses the viewer: `/api/view` (all pages), `/api/needs`, `/api/pulse`, `/api/tasks`,
  `/api/decide`, `/api/nudge`, `/api/unblock`, `/api/lane` and the huddle view.
- The jail runs LogMem's own jail-safe Lua scripts (PR #92), so Unblock and the walkthrough writes work for members.

## 2. Sign-in and sessions

Sign-in:
1. The sign-in screen at `/app` shows "Sign in with your LogMem account" and the admin password form.
2. The member link is a top-level navigation to `GET /api/session?signin=1`. It goes to Clerk's hosted
   sign-in (Account Portal), the same flow as the Connections page. Clerk sends the person back.
3. The server checks the Clerk session (`clerkSession`) and finds the account (`accountFor`).
   Only invited emails get an account, unless `LOGMEM_SIGNUP_OPEN=1`.
4. The server sets `lm_member`: HttpOnly, Secure, SameSite=Lax, 12 hours, signed with HMAC-SHA256 using
   `LOGMEM_SESSION_SECRET`. It holds the tenant id, the Clerk user id and the expiry. Then it redirects to `/app`.

Why our own cookie: Clerk session tokens last about a minute and refresh through Clerk's browser script,
which LogMem pages do not load on purpose. The app polls every 4 seconds, so a Clerk token alone would
bounce people out mid-use. Clerk stays the identity source; `lm_member` remembers it for 12 hours.

Each request:
- A valid `lm_admin` cookie means the admin.
- Otherwise, a valid `lm_member` cookie means that member. The server re-reads the account on each
  request and refuses a disabled or deleted account.
- Otherwise, 401 `{ signin }`.
- `POST /api/logout` clears both cookies. Writes keep the existing intent-header and same-origin checks.

Preview needs:
- Clerk's development instance keys in Preview only (`CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`). Set.
- `LOGMEM_MANAGED=1` in Preview. Set.
- A separate customer Redis for Preview (`LOGMEM_CUSTOMER_REDIS_URI`, Preview value). Infra is asked.
- One fixed Preview address, for example `staging.logmem.si`, aliased to the Preview branch, with Vercel
  deployment protection set so invited testers can reach it. Clerk, invites and testers use that one link.
- `LOGMEM_SESSION_SECRET` (32+ random bytes). Mikey pastes the value into Vercel. No agent sees it.

## 3. Dev and test users (Preview)

- **Invite.** On the Preview Waitlist page, Mikey enters emails and picks a role for each:
  - **Dev**: Mikey and teammates. Plan `dev_internal`, with no limits, so testing never blocks.
  - **Test**: outside testers. The real Free plan, so we see what beta users see.
  The invite stores only the email hash, the role, the time and who invited.
- **Free plan** (PR #93, Mikey's ruling of Oct 20: one tenth of the fleet's measured use):
  1,000 entries a month, 2 agents, 1 space, 100 recalls, 7 days of history.
- **First sign-in.** The person signs up through Clerk themselves. Agents never create accounts.
  LogMem creates their space on the role's plan.
- **Sample data.** An empty space offers "Load sample data" (the Field Notes demo), so a tester can try
  Needs you, Lanes and walkthroughs at once. It writes into their own space only, and counts against Free.
- **Agents.** Preview's Connections page connects Claude, ChatGPT or Codex to the tester's space with the
  existing one-click connect. This is also the plugin pilot: Mikey plus a couple of test users, in ChatGPT and Codex.
- **Reset.** On Preview only, the admin can wipe a test user's space after typing the space id. There is no
  reset in production: the route refuses unless `VERCEL_ENV=preview`.

## Build order

1. PR #92: the jail runs jail-safe scripts (in review).
2. The viewer layer and `lm_member` sessions, with the two-user isolation test.
3. Every web API on the viewer, and admin screens refused for members.
4. Invite roles, the `dev_internal` plan, sample data and Preview reset.
5. The Preview run: the fixed address, secrets set by Mikey, two real sign-ins (task 6 becomes this).

Each step is its own PR with tests first and a Codex review. No merge or deploy without Mikey's GO.

## Out of scope

- Shared team spaces with several people.
- Billing (Square) and plan upgrades.
- Opening production to the public beta. That is a separate GO after Preview works.
