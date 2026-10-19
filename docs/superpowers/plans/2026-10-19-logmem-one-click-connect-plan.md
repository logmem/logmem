# LogMem one-click connect and Free limits — build plan

Spec: `docs/superpowers/specs/2026-10-19-logmem-one-click-connect-design.md` (approved 2026-10-19).
Owner: claude-code. Reviewer: codex, a security review on every PR.
Rules:
- Each task is one PR to `main`, with tests.
- `npm test` and `npm run spec:check` stay green.
- No merge or deploy without Mikey's GO.
- No secret in code, tests, commits, ACMI or LogMem entries.
- Tests use `@example.com` emails and fake Clerk verifiers only.

Depends on: PR #57 (official Redis first) and PR #58 (agent keys and the agent lock) merged first.

## Task 1. Customer Redis jail (`src/http/jail.mjs`)

**Build:**
- `createJail(redis, tenantId)` returns a runner with the same shape as every LogMem runner, `(cmd, ...args) => result`.
- A command table maps each allowed command to its key argument positions. The table covers every command the LogMem store uses: GET, SET, DEL, EXPIRE, TTL, ZADD, ZRANGE, ZRANGEBYSCORE, ZREM, ZCARD, HSET, HGET, HGETALL, HDEL, SADD, SMEMBERS, SISMEMBER, SCARD, INCRBY, EXISTS, SCAN and GETDEL. Extend it from a grep of `src/core`.
- Every key must start with `lm:${namespaceFor(tenantId)}:`. Unknown commands are refused.
- `SCAN` always runs with `MATCH lm:t-{id}:*`, whatever the caller asks for.
- Refused: EVAL, EVALSHA, SCRIPT, FLUSHALL, FLUSHDB, CONFIG, CLIENT, MODULE, MONITOR, SELECT, MIGRATE, DEBUG and KEYS.
- An error is `jail: command not allowed`, and never echoes an argument.
- `customerRedis(env)` reads `LOGMEM_CUSTOMER_REDIS_URI`. It requires `rediss://` (plain `redis://` only in local dev) and throws a config error when the URI is missing.

**Tests** (`test/jail.test.mjs`):
- A key outside the prefix is refused.
- Every key of a multi-key command is checked.
- SCAN always gets the forced MATCH.
- Every blocked command is refused, and errors echo no argument.
- A full LogMem session through `createLogmem({ redis: createJail(memory, "uabc") })` passes, and every key it writes starts with `lm:t-uabc:`.

**Done:** all tests pass, and codex says ready.

## Task 2. Accounts and invites (`src/http/accounts.mjs`, `src/http/invites.mjs`)

**Build:**
- `accountFor({ clerkUserId, email }, { redis, env })`:
  - Looks up `lm:account:clerk:{id}`.
  - If missing and invited, creates the tenant with `createTenant` from `cloud/tenants`: id `u` plus 10 random lowercase letters and digits, plan `free`.
  - Claims the mapping with `SET NX`. The loser of a race reads the winner's mapping.
- Returns `{ tenant, space, plan }`, or `{ waitlist: true }`.
- `isInvited(email)`, `invite(email, by)` and `inviteMany(emails, by)`:
  - The key is `lm:invite:{sha256(lowercased email)}`.
  - `LOGMEM_SIGNUP_OPEN=1` skips the check.
- Not invited: add a waitlist row through `saveSignup` from PR #51 (source `connect`).
- `/app` gets an "Invite" button on waitlist rows and an "Invite all shown" button. Both go through `POST /api/invites`, admin only, with the same CSRF rule as `/api/decide`.

**Tests:**
- First sign-in makes one tenant, also when two sign-ins run at once.
- A second sign-in reuses the tenant.
- The tenant id never contains the email.
- Not invited means no tenant and a waitlist row.
- An invite lets the next sign-in through.
- The open switch works.
- The API's admin and CSRF gates hold.

## Task 3. Managed consent and token binding (`api/oauth/authorize.mjs`, `api/oauth/_lib/storage.mjs`, `src/http/auth.mjs`, `api/mcp.mjs`)

**Build:**
- Add the dependency `@clerk/backend`.
- A verifier module `src/http/clerk.mjs` exports `verifySession(req, env)`, which returns `{ userId, email } | null`. Tests inject a fake.
- With `LOGMEM_MANAGED=1`, the authorize GET:
  1. Without a session, redirects to Clerk's hosted sign-in, with a return URL back to this authorize request (same params).
  2. With a session, calls `accountFor`.
  3. On a waitlist result, renders the waitlist page.
  4. Otherwise renders one button, "Allow {client_name} to use your LogMem memory", plus a "Use a different agent name" link that reveals one field.
- The agent defaults to a slug of `client_name`, run through `checkAgentId`, falling back to `app`.
- On approve, mint the code with the record `{ kind: "managed", tenant, space, agent, plan }`, with no Redis credentials. The PKCE, CSRF and redirect checks stay as they are.
- `resolveAuth` resolves a managed token to the customer Redis wrapped in `createJail`. The result is pinned to the space and to the agent, using the PR #58 lock and `scopedSessionId` keyed on the token family.
- The plan comes from the tenant record, cached for 60 seconds. A suspended tenant returns "This LogMem account is paused."
- Compat mode and the ACMI mirror are off for managed spaces.

**Tests:**
- No session gives the redirect. A waitlist user gives the waitlist page and no code.
- Approve gives a code. Its token resolves to the jailed customer Redis with the right space and agent.
- `logmem_start` as another agent is refused.
- With no `LOGMEM_CUSTOMER_REDIS_URI`, managed sign-in returns 503 and nothing touches the fleet Redis.
- Self-hosted mode (the fields page) still works when `LOGMEM_MANAGED` is unset.

## Task 4. Free limits (`src/http/limits.mjs`, hooks in `src/server.mjs`)

**Build:**
- `createLimits({ meterRedis, tenant, plan })` exposes:
  - `beforeAdd()`: `checkQuota` with `n=1` and the atomic reservation. It throws `quota_exceeded` with the spec's text.
  - `beforeAgentWrite(agent)`: `SADD lm:t-{id}:agents`. A new member past the plan's `agents` count is refused.
  - `historyFloorMs()`: `now - history_days` for plans that have `history_days`, else `null`.
- `createLogmem` accepts `limits`.
  - Every entry-writing tool calls `beforeAgentWrite`, then `beforeAdd`, before it writes: note, update, assign, stage, handoff, accept and recap. The auto-written started and recap entries count too.
  - Every read tool passes `sinceMs: max(caller sinceMs, historyFloorMs())` into the store reads: brief, feed, view, open, recall, jobs and the Brief in start.
- The meter and the registry use the customer Redis directly, outside the jail, with server code only.

**Tests:**
- The grace edge for adds.
- Two writes at once at the edge: only one passes.
- Reads still work after the limit.
- The 4th agent is refused.
- Every read tool hides entries older than 7 days on Free and shows them on Dev.
- Nothing is deleted.

## Task 5. Connected apps in `/app` (`api/connections.mjs`, `public/app.js`)

**Build:**
- Clerk sign-in on `/app` for tenant users, through `verifySession`. The admin password login stays.
- `GET /api/connections` lists the signed-in tenant's token families: app name, agent and last use.
- `POST /api/connections` with `{ action: "disconnect", family }` revokes the family through the existing family revoke and does `SREM lm:t-{id}:agents <agent>`.
- A tenant user sees only their own tenant.

**Tests:**
- The list holds only the user's own families.
- Disconnect revokes the tokens (the next call is 401) and frees an agent slot.
- The CSRF and same-origin gates hold.

## Task 6. Preview end to end and review

**Steps:**
1. Mikey puts the Clerk development keys (application `app_3Kv6QA8XcWPcWDsZ2wWdUMYddkw`) in Infisical, then in Vercel Preview: `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`.
2. Avery's customer Redis URI goes in as `LOGMEM_CUSTOMER_REDIS_URI` (Preview). `LOGMEM_MANAGED=1` goes in Preview only.
3. claude-code invites one `+clerk_test@example.com` address, then runs the done-when list from spec section 1 on the preview deploy with an MCP client. claude-code reports the counts and the paths, never any values.
4. codex reviews the full stack. claude-code fixes the findings.
5. Mikey gives GO for Production: the same env names with production values, then invites.

## Order and owners

| Task | Owner | Waits on |
|---|---|---|
| 1 Jail | claude-code | #57, #58 merged |
| 2 Accounts and invites | claude-code | Task 1 |
| 3 Managed consent | claude-code | Tasks 1 and 2, and the Clerk keys in Preview |
| 4 Limits | claude-code (it can run beside Task 3) | Task 1 |
| 5 Connected apps | claude-code | Task 3 |
| 6 Preview run and review | claude-code, codex, Mikey, Avery | Tasks 1 to 5, Avery's Redis |

Target: Tasks 1 to 5 merged by Nov 6 (G4). Preview run by Nov 9. Invites before the beta on Nov 16.
