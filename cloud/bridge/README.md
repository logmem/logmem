# acmi-bridge

A jailed Redis REST bridge for ACMI Cloud. There is one process per tenant, each with its own token, and each can only
touch its own namespace: `acmi:t-{tenant}:*` and `lm:t-{tenant}:*`. Design: [docs/cloud/BACKPLANE.md](../../docs/cloud/BACKPLANE.md), §3.

The bridge speaks the Upstash REST shape, so existing clients (`src/lib/redis-rest.mjs`, ACMI's Upstash adapter) work
against it unchanged. Point them at `http(s)://<bridge>/exec` (or the bare origin) with the tenant's bridge token.
It has no runtime dependencies: `node:http`, `node:crypto`, and its own RESP2 client (`resp.mjs`) for `redis://`.

## API

| Route | Auth | Body | Reply |
|---|---|---|---|
| `POST /exec` (or `POST /`) | Bearer | `["SET","acmi:t-acme:k","v"]` | `{"result": ...}`, or `{"error": ...}` |
| `POST /pipeline` | Bearer | `[["SET",...],["GET",...]]`, at most 100 | `[{"result":...},{"error":...}]` |
| `GET /health` | none | | `{"ok":true,"tenant":"acme","version":"0.1.0"}` |

Statuses:

| Status | Body | Cause |
|---|---|---|
| 200 | `{result}` or an array of results | success (a pipeline's commands can fail one by one; see below) |
| 400 | `{"error":"bad_request"}` or `{"error":"ERR command failed"}` | bad shape, or Redis refused the command |
| 401 | `{"error":"unauthorized"}` | missing or wrong token |
| 403 | `{"error":"forbidden"}` | refused command, or a key outside the jail |
| 413 | `payload_too_large`, `value_too_large`, `command_too_large`, `too_many_arguments`, `too_many_keys`, `pipeline_too_large` | body over 1 MB, an argument over 512 KB, one command over 1 MB, over 2001 arguments, over 1000 keys, or over 100 commands |
| 429 | `{"error":"rate_limited"}` or `{"error":"upgrade_required"}` | rate bucket empty (also: too many failed auths from one address), or the plan's write quota is used up (reads still work) |
| 503 | `{"error":"unavailable"}` or `{"error":"busy"}` | the quota or meter state is unknown, so writes fail closed; or too many requests in flight |
| 504 | `{"error":"timeout"}` | the upstream command exceeded its deadline |

Error bodies are fixed strings. They never echo a key, a value or the token. Redis error text is cut down to its class
(`WRONGTYPE command failed`, `ERR command failed`).

**Pipelines are all-or-nothing on admission.** The jail, the size limits, the rate bucket and the quota are all checked
before any command runs. If any of them refuses, nothing runs. The reply carries the code and the index of the command
that caused it, for example `{"error":"upgrade_required","index":1}` or `{"error":"forbidden","index":2}`. Read-only
pipelines are never refused for quota. Once admitted, commands run in order, not inside `MULTI`: a failing command
doesn't roll back the ones before it, and its slot holds `{"error": ...}`.

## Jail

- Every key argument must start with `acmi:t-{tenant}:` or `lm:t-{tenant}:` and have something after the prefix. Key
  positions come from a table for each command (`COMMANDS` in `bridge.mjs`), so multi-key commands check every key:
  `DEL`, `MGET`, `EXISTS`, `MSET`, `RENAME`, `COPY`, `SMOVE`, `LMOVE`, `SINTER*`, `ZUNIONSTORE`, `ZINTERSTORE`, and so on.
- The `t-` segment is what keeps tenants away from fleet and system trees (`acmi:agent:`, `acmi:cloud:`, `lm:oauth:`,
  and others). A tenant named `agent` still lives in `acmi:t-agent:`.
- `SCAN`: with no `MATCH`, the bridge forces `MATCH acmi:t-{tenant}:*`. A caller's `MATCH` must start with a tenant
  prefix, otherwise the command is refused.
- `COUNT` for `SCAN`, `HSCAN`, `SSCAN` and `ZSCAN` is capped at 1000. `MATCH` only filters what comes back; Redis still
  walks `COUNT` slots of the shared keyspace.
- Refused: `KEYS`, `EVAL`/`EVALSHA`/`SCRIPT`/`FUNCTION`, `FLUSHDB`/`FLUSHALL`, `CONFIG`, `CLIENT`, `MODULE`,
  `MONITOR`, `SELECT`, `MIGRATE`, `DEBUG`, `SHUTDOWN`, `REPLICAOF`/`SLAVEOF`, `ACL`, `OBJECT`, `SAVE`/`BGSAVE`,
  blocking pops, pub/sub, `MULTI`/`EXEC`, `SORT`, and every command that isn't in the table.

## Limits

| Limit | Default | Notes |
|---|---|---|
| request body | 1 MB | Oversized uploads get a 413. The bridge discards up to 4 MB or 2 s more of the upload so the client sees the status, then closes the connection. |
| one argument | 512 KB | |
| one command | 1 MB, 2001 arguments, 1000 keys | e.g. `MSET` of up to 1000 pairs, `DEL` of up to 1000 keys |
| pipeline | 100 commands | |
| rate bucket | 2000 tokens, refilled at 500/s | A command costs one token per key (minimum 1). `SCAN` costs `ceil(COUNT/100)`. Capacity must be at least the largest pipeline and the key cap, or the bridge refuses to start. |
| failed auth | 10 per source address, then 1/s | Over the limit: 429 and the connection is closed. A valid token is never limited by this. Source = the socket peer: behind a proxy, all clients share the proxy's address. |
| deadlines | 5 s per upstream command, 10 s per request | A pipeline stops at the deadline, and commands that didn't run come back as `{"error":"timeout"}`. |
| concurrency | 64 authenticated requests in flight, 8 unauthenticated, 256 connections | The slot is taken after the token check, so unauthenticated traffic (401s, 404s, `/health`) can't take the slots valid requests need. It has its own small pool, and when that's full the bridge replies and closes the socket without draining. |
| upstream reply | 8 MB | Over the cap, the command fails and the Redis connection is dropped; the next command reconnects. |

## Metering

Each command is classed as `add` (any write) or `read`, and it counts as one op per key (minimum 1). So `MSET` with N
pairs counts as N adds, and `MGET` of N keys counts as N reads. A pipeline counts each of its commands. When a meter
(`cloud/meter`) is configured:

- **Writes are admitted before they run, and the bridge fails closed.**
  - With a plan, the bridge calls `checkQuota(n)` first:
    - `{ok:false, code:"upgrade_required"}` gets a 429.
    - Any other non-ok answer, or a throw, gets a 503.
    - `{ok:true, reserved:true}` means the meter already counted the writes (a refusing plan, through slice A's atomic
      reserve).
    - Otherwise, including grace and billed overage `{ok:true, overage:true}`, the bridge calls `meter(add, n)` before
      running.
  - Without a plan, the bridge calls `meter(add, n)`.
  - If counting fails, the write is refused with a 503 and nothing runs. No write ever lands uncounted.
- **Refunds** cover only writes that certainly didn't happen:
  - writes Redis answered with an error reply (`WRONGTYPE`, `ERR`, `NOPERM`, ...)
  - writes that never ran because the request deadline hit

  Timeouts, dropped connections and protocol errors are never refunded, because the write may have landed. A refund
  uses the meter's `refund()` if it has one, otherwise `INCRBY -n` on `acmi:cloud:meter:{tenant}:{yyyymm}:add` and
  `:ops_total`.
- **Reads** are counted after they succeed, and are never refused. Not even when counting fails: that failure is
  logged as `{"op":"meter","ok":false}`.

**The meter has its own connection, as its own Redis user (`ACMI_METER_REDIS_URL`).** Tenant commands and meter calls
never share a connection or a user. The meter's EVALs are sent as `EVALSHA` first. With a `redis://` upstream and a
meter, `ACMI_METER_REDIS_URL` is required and must be a different user. With a REST upstream and no meter URL, the
meter shares the REST runner, because no ACL split is possible there.

At startup, `main.mjs` runs a self-test against the real upstream and refuses to start if any step fails:

1. `PING`.
2. A write to an `acmi:t-{tenant}:` scratch key (tenant connection).
3. `INCRBY 0` and `EXPIRE` on the meter's own month counter (meter connection).
4. On a refusing plan, the reserve script through `EVALSHA`, with a cap it can never pass, so no counter changes.
5. A `checkQuota` that validates the plan.

It also checks that the tenant user can't reach the meter keys. If it can, the bridge logs a warning (not fatal, since
a dev Redis has no ACLs).

The reserve script refuses `n < 1`, so even a caller holding the meter user can't decrement usage through it.

## Redis ACL (defence in depth)

Each tenant gets two Redis users, defined in [`acl.template.txt`](acl.template.txt). Each runs on its own connection.

| User | Used by | Keys | Commands |
|---|---|---|---|
| `acmi-t-{tenant}` (`ACMI_REDIS_URL`) | every tenant command | `~acmi:t-{tenant}:* ~lm:t-{tenant}:*` | `-@all` then exactly the bridge command table. No `EVAL`/`EVALSHA`, no `@dangerous`, `@admin` or `@scripting`, no `KEYS`. |
| `acmi-meter-{tenant}` (`ACMI_METER_REDIS_URL`) | the meter only | `~acmi:cloud:meter:{tenant}:*` | `-@all +ping +get +incrby +expire +evalsha` |

Neither user has channels. Both rules start with `reset`, so re-applying one (a password rotation, a template change)
replaces the user instead of merging into it. The old password hash and any old selectors are gone.

- **Containment:** a jail bug is contained by Redis itself. The tenant user can't touch other tenants, the fleet, or its
  own usage counters, and the meter user can't touch any data.
- **SCAN caveat:** `SCAN` takes no key argument, so the ACL can't narrow it. The bridge's forced `MATCH` is what limits it.
- **COPY caveat:** key patterns can't restrict `COPY ... DB n`; the jail refuses that option.
- **Database:** `SELECT` isn't granted, so use database 0.

**Slice D's `acmi-cloud` CLI provisions both users.** You never do it by hand. The CLI:

- generates the passwords and stores them in Infisical
- applies each rule with `ACL SETUSER`, with the password as a sha256 hash
- loads the reserve script (`SCRIPT LOAD`). This must be repeated after a Redis restart. Until it is, writes on
  refusing plans fail closed and a starting bridge refuses to start.
- sets `ACMI_REDIS_URL_{TENANT}` and `ACMI_METER_REDIS_URL_{TENANT}` for the compose service

A URL with a user but no password is refused at startup. It's never silently run as Redis's `default` user.

## Reply values

Replies from a `redis://` upstream are binary-safe:

- a bulk string that is valid UTF-8 comes back as a JSON string
- any other bulk string comes back as `{"$base64": "<base64 of the raw bytes>"}`
- integers beyond 2^53 come back as decimal strings

The RESP parser is strict and incremental:

- lengths and integers must be ASCII digits with an optional leading `-`
- every bulk must end in CRLF
- parse state is kept between chunks, so nothing already parsed is read again
- a reply nobody asked for drops the connection

## Run one

```sh
# The token is generated by `acmi-cloud tenant create` and shown once. Only its hash goes in env.
export ACMI_TENANT=acme
export ACMI_BRIDGE_TOKEN_SHA256=<sha256 hex of the bridge token>
export ACMI_REDIS_URL='redis://acmi-t-acme:<password>@redis:6379'   # or an https:// REST upstream + ACMI_REDIS_TOKEN
export ACMI_BRIDGE_PORT=8080
export ACMI_PLAN_QUOTAS=dev                                          # plan id from cloud/plans.json, or a JSON plan
node cloud/bridge/main.mjs
```

Docker (build from the repository root; `/.dockerignore` keeps the context to what the image copies):

```sh
docker build -f cloud/bridge/Dockerfile -t acmi-bridge:0.1.0 .
docker run --rm -p 127.0.0.1:8080:8080 --env-file acme.env acmi-bridge:0.1.0
```

The image installs no npm packages. It copies only `src/lib`, `cloud/bridge`, `cloud/meter`, `cloud/tenants` (the
meter imports it) and `cloud/plans.json`, and runs as `node`. The base image is pinned by digest
(`node:22-alpine`, multi-arch index); the Dockerfile says how to bump it.

For Elestio, the control plane renders `compose.template.yml` once per tenant (`acmi-bridge-{tenant}`). Secrets come
from Infisical at deploy time and are never written into the file.

- **Ingress:** use one mode only.
  - **Default:** the reverse proxy is a container on `acmi-edge`. The bridge publishes no host port.
  - **Alternative**, when the proxy runs on the host: drop `acmi-edge` and publish `127.0.0.1:{port}`.
- **Networks:** both are external. `acmi-cloud bridge render` must check that `acmi-redis` is internal and that Redis
  isn't attached to `acmi-edge` before it deploys.

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `ACMI_TENANT` | yes | bare tenant id, `^[a-z][a-z0-9-]{2,30}$` |
| `ACMI_BRIDGE_TOKEN_SHA256` | yes | sha256 (hex) of the bridge token. The token itself never goes in env. |
| `ACMI_REDIS_URL` | yes | `redis://`/`rediss://` as the tenant's ACL user, or `http(s)://` (REST upstream) |
| `ACMI_REDIS_TOKEN` | for http(s) | bearer token for a REST upstream |
| `ACMI_METER_REDIS_URL` | with a meter on `redis://` | the meter's own connection, as `acmi-meter-{tenant}` |
| `ACMI_METER_REDIS_TOKEN` | for an http(s) meter URL | bearer token for it |
| `ACMI_BRIDGE_PORT` | no | listen port, default 8080 |
| `ACMI_BRIDGE_HOST` | no | listen address, default 0.0.0.0 |
| `ACMI_PLAN_QUOTAS` | no | plan id or JSON plan. If it's set and there's no meter module, the bridge refuses to start. |
| `ACMI_METER_MODULE` | no | meter module path, default `cloud/meter/index.mjs` |
| `ACMI_BRIDGE_RATE_CAPACITY` | no | rate bucket size in tokens (per key), default 2000 |
| `ACMI_BRIDGE_RATE_PER_SEC` | no | refill rate, default 500 tokens per second |
| `ACMI_BRIDGE_MAX_CONNECTIONS` | no | `server.maxConnections`, default 256 |
| `ACMI_BRIDGE_MAX_IN_FLIGHT` | no | concurrent requests, default 64 |

## Logs

The bridge writes one JSON line per command or refusal to stdout:

```json
{"tenant":"acme","op":"add","cmd":"SET","ok":true,"ms":0.42}
```

The fields are `tenant`, `op`, `cmd`, `ok` and `ms`, and nothing else. Logs never carry keys, values, tokens, token
hashes or the Redis URL. A command name outside the table is logged as `?`.

## Known limits

- A pipeline is not atomic once it is admitted (see API).
- `src/lib/redis-native.mjs`, the server's runner, now passes every bridge command through too. The bridge itself
  uses `resp.mjs`, so the image needs no `redis` package.
