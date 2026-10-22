# LogMem one-click connect and Free limits — design

Status: DRAFT for Mikey's review, 2026-10-19. Owner: claude-code.
Scope: sub-project 1 (one-click connect) and sub-project 2 (Free limits) of the general release. Sub-project 3 (the Muse connector package) and sub-project 4 (legal pages and cookies) get their own specs.
Builds on: `docs/cloud/BACKPLANE.md` (tenants, jail, meter), `cloud/plans.json`, the hosted MCP server (`api/mcp.mjs`, `api/oauth`), PR #57 (official Redis first) and PR #58 (agent keys).

## 1. Goal

A regular person connects an app such as Muse to LogMem in one click. They never see a Redis URL, a token, a "space" field or a "backend" field. A Free account has enforced limits, so the beta can run on the Elestio VM we already pay for.

Done when an invited test user with an `@example.com` email does all of this on a preview deploy, with no manual step outside the browser:

1. adds `https://logmem.si/api/mcp` to an MCP app
2. signs in
3. clicks one button
4. writes a note
5. hits the Free add limit, and still reads

## 2. Decisions (Mikey, 2026-10-19)

| Question | Decision |
|---|---|
| First spec | One-click connect and Free limits together |
| Sign-in | Clerk (Google, GitHub, email). Free plan, $0 up to 10,000 monthly users |
| Where Clerk fits | LogMem keeps its own OAuth server. Clerk only tells it who the person is |
| Storage | One official Redis on the Elestio VM, separate from the fleet Redis. Each user gets space `t-{id}`. A code jail keeps every command inside that space |
| Agent name | The connection is locked to one agent named after the app (for example `muse`). A "change name" link covers two windows of one app |
| Free history | Nothing is deleted. Free reads show the last 7 days. Upgrading shows older entries again |
| Who joins | Invited waitlist people only, in batches. One switch opens sign-up later |

## 3. The user flow

1. The user adds the server URL `https://logmem.si/api/mcp` in their app. The app registers itself through dynamic client registration (live today).
2. The app opens `https://logmem.si/api/oauth/authorize`. The page shows Clerk's sign-in.
3. On the first sign-in, LogMem checks the invite list:
   - **Invited:** LogMem creates the tenant and its space at once (section 4.1).
   - **Not invited:** the page says "You're on the list. We'll email your invite." The email is added to the waitlist if it is not there yet. The flow ends with no token.
4. The consent page shows one button: "Allow {app name} to use your LogMem memory." There are no fields. A small link, "Use a different agent name", shows one text field for the agent id.
5. The app gets a token bound to the tenant, the space and the agent. The connection works.

The existing consent page, which asks for a Redis URL and token, stays for people who bring their own Redis. That is "self-hosted mode". The managed flow above is "managed mode". The deploy picks managed mode when `LOGMEM_MANAGED=1` and the Clerk keys are set.

## 4. Building blocks

Each block is one module with one job. Each has its own tests.

### 4.1 Accounts (`src/http/accounts.mjs`)

- **Input:** a verified Clerk session (user id and primary email).
- **Output:** the person's tenant.
- **Records:**
  - `acmi:cloud:tenant:{id}` (from `cloud/tenants`): plan `free`, status `active`.
  - `lm:account:clerk:{clerk_user_id}`: the tenant id.
- **Tenant id:** `u` plus 10 random lowercase letters and digits. It never comes from the email. It must pass `validTenantId`.
- **Space:** `namespaceFor(id)`, which gives `t-{id}`. Use `namespaceFor`; never build the prefix by hand.
- **Idempotent:** a second sign-in finds the existing tenant through the Clerk mapping. Two sign-ins at the same moment create one tenant (`SET NX` on the mapping).

### 4.2 Invite list (`src/http/invites.mjs`)

- **Record:** `lm:invite:{sha256(lowercased email)}`, holding the time and who invited. The email itself is never a key.
- **Gate:** a new account needs an invite record, or `LOGMEM_SIGNUP_OPEN=1`.
- **Admin:** `/app` gets an "Invite" action on waitlist rows. One row or a batch, signed-in admin only, with the same CSRF rule as `/api/decide`.
- **Invite email:** out of scope here. Mikey sends invites by hand for now. The Resend invite email comes with the Track 1 work.

### 4.3 Consent page, managed mode (`api/oauth/authorize.mjs`)

- **Step 1:** check the Clerk session with Clerk's server SDK and `CLERK_SECRET_KEY`. With no session, render Clerk's sign-in, then come back.
- **Step 2:** resolve the account (4.1), or show the waitlist page (section 3, step 3).
- **Step 3:** render one button. The agent id defaults to a slug of the client's `client_name` (`checkAgentId`). If the slug is not a valid id, it defaults to `app`.
- **Approve:** mint the auth code with the binding in 4.4. The CSRF, PKCE and redirect rules from today's page stay unchanged.
- **Deny:** today's `access_denied` redirect.

### 4.4 Token binding (`api/oauth/_lib/storage.mjs`, `src/http/auth.mjs`)

- **A managed token record holds** `{ kind: "managed", tenant, space: "t-{id}", agent, plan }`. It holds no Redis credentials.
- **`resolveAuth`** maps it to the customer Redis backend (4.5), pinned to the space and the agent. The agent lock is the one from PR #58.
- **Plan:** read live from the tenant record on each request (cached for 60 seconds), so an upgrade applies at once.

### 4.5 Customer Redis jail (`src/http/jail.mjs`)

- **Backend:** `LOGMEM_CUSTOMER_REDIS_URI` (`rediss://`, required in managed mode). It is never the fleet Redis.
- **Jail:** every command passes through a runner that allows only keys starting with `lm:t-{id}:`. This applies the rules in `docs/cloud/BACKPLANE.md`:
  - A table resolves the key arguments for each command.
  - Cross-key commands check every key.
  - `SCAN` gets a forced `MATCH lm:t-{id}:*`.
  - `EVAL`, `SCRIPT`, `FLUSH*`, `CONFIG`, `CLIENT`, `MODULE`, `MONITOR`, `SELECT`, `MIGRATE`, `DEBUG` and `KEYS` are refused.
  - A refusal is a generic error that never echoes arguments.
- **Compat and mirror:** the ACMI compat mode and the ACMI mirror are off for managed spaces.
- **Meter and registry:** the meter (`acmi:cloud:meter:*`) and the registry (`acmi:cloud:tenant:*`) are reached by server code outside the jail, never through a user's runner.
- **One module:** a later per-user bridge uses the same jail module.

### 4.6 Limits (`src/http/limits.mjs`)

Plan numbers come from `cloud/plans.json` and are never hard-coded.

- **Adds:**
  - Each written entry is one add (a note, update, handoff, accept or recap). A Redis command is not an add.
  - Before the write, `checkQuota` reserves the add with the existing atomic reservation. Free and Dev get a 10% grace. After the grace, the tool returns `quota_exceeded` with the text "This space used its {n} free entries this month. Reads still work. Upgrade at logmem.si." The tool writes nothing.
  - Reads are counted and never refused.
- **Agents:**
  - The first write by an agent adds it to `lm:t-{id}:agents` (a set).
  - On Free, a 3rd agent's first write is refused with "Free allows 2 agents. Disconnect one at logmem.si/app, or upgrade."
- **History:**
  - On Free, every read tool gets a floor of now minus `history_days` (7). This covers `logmem_brief`, `feed`, `view`, `open`, `recall`, `jobs` and the Brief inside `logmem_start`.
  - Entries older than the floor are not returned. They are not deleted.
- **Spaces:** 1 on Free. Managed mode has no "create space" path in this spec.

### 4.7 Connected apps (`/app`)

- **List:** a "Connected apps" list per tenant, showing each app name, agent and last use.
- **Disconnect:** revokes the app's whole token family and removes the agent from the agents set, which frees a Free slot.
- **Access:** only the signed-in tenant owner sees their own list. That needs a Clerk session on `/app` for tenant users, next to today's admin password login.

## 5. Failures (every one fails closed)

| Case | Behaviour |
|---|---|
| Clerk is unreachable | "Sign-in is unavailable. Try again in a minute." No code is minted, and nothing is stored |
| Not invited | The waitlist page from section 3. No token |
| `LOGMEM_CUSTOMER_REDIS_URI` is missing or down | Managed sign-in returns 503. Tool calls return "LogMem memory is temporarily unavailable." There is never a fallback to the fleet Redis or to memory |
| Over the add limit | `quota_exceeded`. Reads keep working |
| 4th agent on Free | Refused with the message in 4.6 |
| Token expired | The app refreshes it (12-hour access token, 30-day refresh token). After 30 days without use, the user signs in again |
| A tenant is suspended | Tool calls return "This LogMem account is paused." |

## 6. Testing

- **Jail:** keys outside the prefix are refused, in single-key and cross-key commands. SCAN gets the forced prefix. Blocked commands are refused. Errors never echo arguments.
- **Accounts:** first sign-in creates one tenant, also with two sign-ins at the same moment. A second sign-in reuses it. The tenant id never contains the email.
- **Invites:** not invited means no account and a waitlist row. Invited means an account. The open switch works.
- **Consent:** managed mode with a fake Clerk verifier. The binding holds the tenant, space, agent and plan. The agent lock refuses other ids.
- **Limits:**
  - The add count at the grace edge, and two calls at once.
  - Reads after the limit.
  - The 4th agent refused, and the slot freed by Disconnect.
  - The history floor in every read tool, lifted by an upgrade.
- **Fail closed:** with no customer Redis, nothing works and nothing touches the fleet Redis.
- **Fleet:** the `madez` space, the agent keys and the dogfood check work unchanged.
- **End to end on a preview deploy:** a Clerk test instance and an `@example.com` user, from connect through first write to the limit.
- **Review:** a security review by codex before merge.

## 7. Setup

| Who | What | Cost |
|---|---|---|
| Mikey | Create a Clerk application on the free plan with Google, GitHub and email sign-in. Put `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in Infisical, then in Vercel (Preview first, Production at launch) | $0 |
| Mikey | Free numbers in `cloud/plans.json`: 1,000 adds a month, 2 agents, 1 space, 7 days of history, 100 recalls. One tenth of the fleet's measured use, Mikey's ruling of 2026-10-20 (was 10k adds, 3 agents, 1,000 recalls) | none |
| Mikey | Send the first invites from `/app` | none |
| Avery | Widen the brief `madezmedia/fleet docs/LOGMEM-OAUTH-REDIS.md` from "sign-in records" to "customer Redis" (see the ACL below). Same VM, TLS, AOF, `noeviction` | $0 extra |
| claude-code | The build, in small PRs with tests. No merge or deploy without Mikey's GO | none |

**Customer Redis ACL.** The user `logmem-app` may use these key patterns:
- `~lm:oauth:*` and `~lm:agentkey:*`
- `~lm:account:*` and `~lm:invite:*`
- `~lm:t-*`
- `~acmi:cloud:*`

It may run the commands LogMem uses, including `EVAL` and `EVALSHA`, because the meter's atomic reservation runs a Lua script. The code jail in 4.5 still stops users from reaching `EVAL`. The `default` user is off.

Env names:
- `LOGMEM_MANAGED=1`
- `LOGMEM_CUSTOMER_REDIS_URI` (`rediss://`)
- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`
- `LOGMEM_SIGNUP_OPEN` (unset during the beta)

The deploy-owner OAuth store moves from the fleet Redis to the customer Redis through `LOGMEM_DEPLOY_REDIS_URI` (PR #57).

## 8. Build order

Each step is one PR with its own tests:

1. The jail and the customer Redis backend (4.5).
2. Accounts and invites (4.1, 4.2).
3. The managed consent page and token binding (4.3, 4.4).
4. Limits (4.6).
5. Connected apps in `/app` (4.7).
6. The preview end-to-end run and the codex review.

Target: invites go out before the beta on Nov 16. Show HN on Nov 10 can say "beta invites open".

## 9. Not in this spec

- Payments (Square now, Stripe metered later).
- The Muse connector package and guide (sub-project 3).
- Privacy, terms and the cookie banner (sub-project 4, which builds on #53). The beta does not open to the public until sub-project 4 ships.
- Per-user bridges, memory search (recall indexing), more than one space per user, invite emails, account export and deletion.

## 10. Open questions

1. **Recall limit.** Resolved. Free recall is 1,000 per month, confirmed by Mikey on 2026-10-19. `cloud/plans.json` keeps `free.limits.recall` at 1000.
2. **Clerk session on `/app` for tenant users.** This spec adds it next to the admin password. Keep both, or move the admin to Clerk too? Default: keep both until after the beta.
