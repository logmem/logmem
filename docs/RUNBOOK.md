# LogMem runbook

Operator procedures for the Vercel deploy and its Redis backends. Covers GAPS.md
Tier 3 items O1 to O7. Steps marked **TODO (infra)** depend on VM or provider
details that are not in this repo yet; fill them in the first time someone runs
the procedure.

## Quick reference

| What | Where |
|---|---|
| Health | `GET /api/health`: `{ok, version, commit, redis_ms, region}`, 503 when the backend PING fails or takes over 3 s |
| Version on the wire | MCP `serverInfo.version` = `package.json` version + `+<sha7>` on Vercel builds |
| Runtime logs | Vercel dashboard, Project, Logs (or `vercel logs <deployment-url>`). `/api/health` writes one JSON line per request (`src/http/log.mjs`); filter on `"route":"/api/health"` |
| stdio logs | the MCP client's stderr for the `logmem-mcp` process, prefixed `[logmem]` |
| CI | `.github/workflows/ci.yml`: `npm ci`, `npm test`, `npm run spec:check`, `npm run conformance` on Node 22 |
| Redis timeout | `LOGMEM_REDIS_TIMEOUT_MS` (default 5000) per command, REST and native |

## 1. Deploy and rollback

Production should deploy only from `main`, and only after CI is green. Until the
branch protection in GAPS O1 is on, check the commit's CI run by hand first.

**Deploy:** merge to the production branch. Vercel builds it. After the build,
check:

```sh
curl -s https://<prod-domain>/api/health | jq
# ok:true, commit matches the merged SHA (first 7 chars), redis_ms well under 1500
```

**Roll back** (fastest: points prod at the previous good deployment, no rebuild):

```sh
vercel ls --prod                      # find the last good deployment URL
vercel rollback <good-deployment-url> # or `vercel rollback` for the immediately previous one
curl -s https://<prod-domain>/api/health | jq .commit
```

**Promote** a preview that has been verified (for example, a fix tested on its preview URL):

```sh
vercel promote <preview-deployment-url>
```

A rollback in Vercel disables auto-assignment of production domains for later
deploys. Once the fix is merged, run `vercel promote` on the new deployment, or
turn auto-assign back on in the dashboard, or prod will stay pinned to the rollback.

Env var changes need a redeploy to take effect (`vercel redeploy <url>`, or push a commit).

## 2. Bridge or Redis down

Symptoms: `/api/health` returns 503 (`backend unreachable` or `backend timed out after 3000ms`),
MCP tool calls fail with `Redis REST <CMD>: timed out after 5000ms` or `... network error`,
and stdio clients log `using in-memory (degraded)`.

1. Confirm it is the backend and not Vercel: `curl -s https://<prod-domain>/api/health`.
   A 503 with `redis_ms` near 3000 means a hang. A fast 503 means refused or an auth failure.
2. Check the bridge from the VM side. **TODO (infra):** bridge service name,
   `systemctl status <bridge>` / container name, and the Redis it fronts
   (`redis-cli -p <port> PING`).
3. Restart the bridge, then Redis if needed. **TODO (infra):** exact commands.
4. Watch `/api/health` go back to 200.

What clients do while it is down:

- **HTTP (Vercel):** reads are retried once after 200 to 400 ms. Writes are never
  retried; a write that timed out may or may not have landed. Agents get an error
  and should retry the write themselves once health is green.
- **stdio:** if the backend was down at startup, the process runs **in memory**.
  Every tool result carries `degraded: true`. It PINGs the real backend every 60 s
  and switches over when it answers. **Writes made while degraded are not copied
  to the real backend and are lost when the process exits.** If an agent's work
  must not be lost, run it with `LOGMEM_REQUIRE_BACKEND=1`: the process exits 1
  with a clear message instead of starting degraded.
- After an outage, ask agents whose sessions showed `degraded: true` to re-log
  anything important (a `logmem_note` that summarises it is enough).

## 3. Redis backups and restore

**Status: not in place (GAPS O3).** No backup is taken today. This section is the
target procedure; it needs VM access to set up.

### Set up (one time)

1. On the Redis host, turn on both persistence modes in `redis.conf`:
   ```
   save 900 1
   save 300 10
   appendonly yes
   appendfsync everysec
   ```
   then `redis-cli CONFIG REWRITE` (or restart). **TODO (infra):** config path on the VM.
2. Nightly off-box copy of the RDB snapshot:
   ```sh
   redis-cli BGSAVE
   # wait until LASTSAVE changes
   cp /var/lib/redis/dump.rdb /backups/logmem-$(date -u +%F).rdb
   # upload to off-box storage
   ```
   **TODO (infra):** off-box target (bucket, credentials), cron or systemd timer, retention (suggest 14 daily + 6 monthly).
3. Alert if the newest backup is older than 36 h. **TODO (infra).**

### Restore

1. Stop writers: roll Vercel to maintenance, or remove the backend env vars and redeploy, so `/api/health` is 503 on purpose. Stop the bridge.
2. Stop Redis: `systemctl stop redis` (**TODO (infra):** service name).
3. Move the current data aside, do not delete it:
   `mv /var/lib/redis/dump.rdb /var/lib/redis/dump.rdb.pre-restore; mv /var/lib/redis/appendonlydir /var/lib/redis/appendonlydir.pre-restore`
4. Put the chosen backup in place as `dump.rdb`, owned by the redis user.
5. With AOF on, Redis loads the AOF instead of the RDB at startup. To restore from the RDB:
   start with `appendonly no`, check the data, then `redis-cli CONFIG SET appendonly yes`
   (this rewrites a fresh AOF from memory), then `CONFIG REWRITE`.
6. Verify: `redis-cli DBSIZE`, spot-check `lm:madez:*` keys, then bring the bridge and Vercel back and check `/api/health`.
7. Log the restore as a decision entry in LogMem (time, backup used, data window lost).

**Monthly drill:** restore last night's backup onto a scratch Redis (never prod),
run `LOGMEM_REDIS_URI=redis://<scratch> npm run conformance` and a key count, record the result.

## 4. Token or secret compromise

Treat any leak of the values below as a full compromise of that credential. Rotate first, investigate after.

| Secret | Where it lives | Rotate |
|---|---|---|
| `LOGMEM_ADMIN_PASSWORD` (and `LOGMEM_ADMIN_SECRET` if set) | Vercel env | Set a new value, redeploy. Every admin cookie stops working at once (the cookie is signed with a key derived from it). |
| `LOGMEM_DECIDE_SECRET` (min 32 chars, e.g. `openssl rand -hex 32`) | Vercel env and any MCP server that serves Briefs | Set a new value everywhere at once, redeploy. Decisions signed with the old key stop verifying, so their asks show as pending again; re-answer the ones still relevant. Unset = `/api/decide` answers 503 and nothing counts as decided (fail closed). `LOGMEM_ADMIN_ID` (default `admin`) names the person the web login decides as. |
| `LOGMEM_OAUTH_KEK` | Vercel env (from the OAuth hardening track) | Set a new key, redeploy, then purge OAuth records (below): records sealed with the old key cannot be read. |
| Bridge token (`LOGMEM_REST_TOKEN` / `ACMI_BRIDGE_TOKEN` / `LOGMEM_DEPLOY_REST_TOKEN`) | Vercel env and the bridge config on the VM | Issue a new token on the bridge (**TODO (infra)**), update every Vercel env that holds it, redeploy, then revoke the old token on the bridge. Update stdio clients' env. |
| `LOGMEM_DIRECT_AUTH_TOKEN` (break-glass bearer) | Vercel env | Remove it, or set a new one, and redeploy. |
| Upstash REST token | Upstash console | Reset the token in the console, update env, redeploy. |

**Purge OAuth state** after a KEK or deploy-Redis compromise. This logs out every OAuth client; they re-run the flow.
Run it against the deploy-owner Redis only, from a trusted shell:

```sh
redis-cli --scan --pattern 'lm:oauth:*' | xargs -r -n 500 redis-cli DEL
```

Keys removed: `lm:oauth:client:*`, `lm:oauth:code:*`, `lm:oauth:token:*`, `lm:oauth:refresh:*`.
They sit outside every space, so no `lm:<space>:*` memory is touched.

Afterwards: check Vercel logs for requests made with the leaked credential (time window, routes),
and record the incident in LogMem as a decision entry.

## 5. Mirror retry backlog

With `LOGMEM_MIRROR_ACMI=1`, every `lm:<space>:*` write is also written to
`acmi:<space>:*`. A failed copy is queued in `lm:<space>:mirror:retry` (ZSET, score = ms)
and up to 50 are retried at the start of the next tool call. The daily dogfood
check counts what is still queued as mismatches.

```sh
redis-cli ZCARD lm:madez:mirror:retry                 # backlog size
redis-cli ZRANGE lm:madez:mirror:retry 0 4            # oldest five, with the error that queued them
```

- **Backlog growing:** the ACMI side is failing (often WRONGTYPE on an index key written by
  another tool, or the bridge rejecting a command). Read the `error` field on the oldest
  entries, fix the cause, then make any tool call in that space to start draining.
- **Backlog stuck but healthy:** each call drains 50; a large backlog takes several calls.
  Call `logmem_connection` or any read in a loop to drain it.
- **Giving up on entries:** only with a decision logged. `ZREM` the specific members;
  never `DEL` the key without exporting it first (`ZRANGE ... 0 -1 > backlog.json`).

## 6. Logs and metrics

- **Vercel runtime logs** keep a short retention. For anything longer, attach a log
  drain in the Vercel dashboard (**TODO (infra):** pick a destination).
  This change does not configure one.
- **Structured request logs:** `src/http/log.mjs` exports `logRequest({route, method, tool, ms, ok, status, err})`,
  one JSON line on stdout. Only `/api/health` uses it so far; other routes can adopt it.
  Never pass tokens, URLs, headers or bodies to it.
- **SLO target (GAPS O4):** 99.5% of `/api/health` checks green per 30 days; p95 MCP call under 1.5 s.
  Point an external uptime checker at `/api/health` (**TODO (infra):** which one, who gets paged).
