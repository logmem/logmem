# LogMem go-live — design (draft for Mikey's approval)

Status: DRAFT, 2026-10-15. Mikey chose option C: two tracks at once. Nothing here creates an account, spends money or
deploys. Each item marked **[Mikey]** needs his account or his GO.

## Goal

Real people use LogMem. They sign up, get a space, connect their agents and pay. Two offer ladders:

- **Ladder 1, DIY:** self-managed by the customer, hosted by us. Prices: [LADDER 1 PRICES — Mikey].
- **Ladder 2, done-for-you:** white-glove, fully managed and hosted by us. Prices: [LADDER 2 PRICES — Mikey].

`docs/PRICING.md` and `cloud/plans.json` hold the current self-serve ladder (Free $0, Dev $19, Pro $49, Team $99,
Agency $199, Enterprise). They change only after Mikey sets the two ladders.

## Track 1 — design partners on today's stack (days)

1. **Waitlist inbox.** A read-only list in the LogMem admin: email, agents, plan, date. The data already lands in
   `lm:onboard:waitlist:*` (`api/onboarding/waitlist.mjs`).
2. **Confirmation email.** One plain email on sign-up, sent with Resend. **[Mikey]** creates the Resend account and
   verifies the sending domain (SPF, DKIM, DMARC on `logmem.si`).
3. **Invite.** Mikey picks a person in the inbox. An invite creates a tenant with `cloud/tenants` on the current
   Redis (namespace `t-{id}`), makes one API key shown once, and emails a link to a setup page. The key never goes
   into an email body, a log or LogMem.
4. **Hosted MCP for tenants.** `/mcp` accepts a tenant key and binds the connection to that tenant's space, metered by
   `cloud/meter`. Today it serves only the fleet space.
5. **Done:** 5 design partners connect agents and write entries in their own spaces.

## Track 2 — Elestio auto-deploy (weeks)

1. **Provisioner (slice D).** `acmi-cloud tenant create <id> --plan <plan>` writes the registry, makes the key, renders
   the per-tenant bridge compose service and the Qdrant payload index.
2. **Elestio deployer.** It takes the rendered service and starts it on the right Elestio host for the tier, through
   Elestio's API. First step: check what Elestio's API can do (create a service, set env, health check).
3. **Payment trigger.** A paid checkout calls the provisioner. A cancel calls `tenant suspend`.
4. **Infra per tier.** One bridge per tenant on every tier (Mikey's rule).

| Tier | Redis | Bridge | Qdrant | Host |
|---|---|---|---|---|
| Free, Dev | Shared, namespace `t-{id}` | Own container, small | Shared collection, tenant filter | Shared Elestio pool |
| Pro, Team | Shared, higher limits | Own container | Shared, tenant filter | Shared pool, larger VMs |
| Agency | Own Redis database | Own container | Shared, tenant filter | Shared or dedicated VM |
| Enterprise and ladder 2 | Own Redis | Own container | Own collection | Dedicated Elestio VM |

## Services (Mikey's picks, plus what each one is for)

| Need | Service | Notes |
|---|---|---|
| Product analytics | PostHog | Funnel: visit → waitlist → invite → first entry → paid. Server-side events from the API. No email or key in event properties. |
| Marketing analytics | Google Analytics | Landing page and campaign source only. Needs a cookie banner (decline by default). |
| Courses and community | Whop | Stays for EZ Lab and Agent Lab. Not LogMem billing. |
| Payments | Stripe (recommended) or Square | Stripe has metered billing for the overage in `plans.json`, plus tax and dunning. Square has no native usage billing. **[Mikey]** picks. |
| Auth for people | Clerk | Web login for the admin and customer dashboard. MCP OAuth stays on LogMem's own server (`api/oauth`), with Clerk as the identity behind it. |
| Transactional email | Resend | Confirmation, invite, receipts, usage warnings. |
| SMS and messages | Sent.dm | Optional alerts and login codes. US SMS needs 10DLC brand and campaign registration first. **[Mikey]** |
| Outside tool connections | Composio | Only where a customer's agents need a third-party tool. Not in the sign-up path. |

## What is missing today (gaps)

1. **Privacy policy and terms.** `/privacy` and `/terms` return 404. These are required before taking emails at scale,
   payments, cookies or SMS. Bentley has an outline. A lawyer reviews them. **[Mikey]**
2. **Cookie consent** for PostHog and Google Analytics. Decline by default.
3. **Sending-domain DNS** for Resend (SPF, DKIM, DMARC).
4. **Error tracking and uptime.** No alerting exists for logmem.si or the bridges. Add a status check per tenant
   bridge.
5. **Backups and data export.** No tenant Redis backups, no export, no delete-my-data path.
6. **Usage page.** Customers can't see their usage against plan limits yet.
7. **Free-tier abuse controls.** Open question 3 in `docs/cloud/BACKPLANE.md`.
8. **Embedding provider** for recall. Open question 2. **[Mikey]**
9. **Docs and support.** A quickstart page and one support channel.
10. **Secret handling** for all these new keys: the P0 keymaster (PR #48) holds them per agent.
11. **GitHub billing.** Actions is down, so no PR runs CI.

## Lanes (proposed split)

| Work | Owner | Depends on |
|---|---|---|
| This spec, the plan, Track 1 build (inbox, invite, tenant MCP), integration contract | claude-code + subagents | Mikey approves this spec |
| Elestio API check and deployer, infra per tier | grok (infra) | Elestio API access **[Mikey]** |
| Provisioner CLI (slice D) | grok-local | Plan task |
| Stripe or Square checkout and webhook, Clerk login | Cursor, via bentley-main | Mikey's payment pick and accounts |
| PostHog and GA events, funnel dashboard | muse | Cookie banner, privacy page |
| Privacy and terms pages, PR reviews | bentley-main | Lawyer review **[Mikey]** |
| Email and onboarding visuals | open-design | Copy from claude-code |
| Uptime and bridge health checks | ops-center | Deployer |

## Rules that hold everywhere

- No secret, API key or customer email in any LogMem or ACMI entry, PostHog event or log line.
- Every new key goes into Infisical under the P0 folder layout.
- No account creation, spend, deploy or send without Mikey's GO.
- Customer-facing copy says LogMem, never ACMI, except the "Built on ACMI" section.
