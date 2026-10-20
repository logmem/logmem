---
name: logmem-self-host
description: Use this instead of acmi-self-hosted-redis and acmi-self-hosting (ACMI). Run LogMem on your own Redis, with the official Redis server over TLS or an HTTP REST bridge, for the local server or the hosted deploy. Covers env settings, key layout, moving data from ACMI, and the known operational pitfalls.
---

# Self-host LogMem

LogMem keeps everything in Redis you own. Use the official Redis server where you can. Use an HTTP REST bridge only for hosts that cannot open a TCP connection.

## When this skill applies

- You set up LogMem for a new team, a new machine or a new deploy.
- You move a team from ACMI keys to LogMem keys.
- A self-hosted Redis or bridge misbehaves after a restart or a move.

## 1. Pick the backend

| Backend | Setting | Use when |
|---|---|---|
| Official Redis over TLS | `LOGMEM_REDIS_URI=rediss://<user>:<password>@<host>:<port>/0` | Default. Any machine that can open TCP |
| HTTP REST bridge | `LOGMEM_REST_URL=https://<host>/bridge/exec` and `LOGMEM_REST_TOKEN=<token>` | Serverless hosts, or networks that allow only HTTPS |

The first match wins: a Redis URI over a REST pair. Keep secrets in your vault or the host's env settings, never in a file you commit.

## 2. Run the local server

```text
node <path>/logmem/src/stdio/index.mjs
```

The env settings are:

- `LOGMEM_SPACE=<space>`
- `LOGMEM_AGENT=<agent id>`
- the backend from step 1
- optionally `LOGMEM_ACMI_COMPAT=1` (read old ACMI keys) and `LOGMEM_MIRROR_ACMI=1` (copy each new entry to ACMI)

With no backend, the server runs in memory and says `degraded: true`. Nothing it writes is saved.

## 3. The hosted deploy

These are the main env settings on the deploy:

| Setting | What it is |
|---|---|
| `LOGMEM_SPACES` | The spaces the deploy serves |
| `LOGMEM_DEPLOY_REDIS_URI` (or `LOGMEM_DEPLOY_REST_URL` and `_TOKEN`) | Where sign-in records live. Keep it separate from shared team data |
| `LOGMEM_OAUTH_KEK` | 32 random bytes. It seals stored connection credentials |
| `LOGMEM_ADMIN_PASSWORD` | The web app's admin sign-in |
| `LOGMEM_MANAGED=1`, `LOGMEM_CUSTOMER_REDIS_URI`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Managed accounts with one-click connect |

Make each key with `openssl rand -base64 32`, piped straight to the clipboard, and save it in your vault before the deploy settings.

## 4. Key layout

| Key | Type |
|---|---|
| `lm:{space}:{ns}:{id}:who` | string (JSON) |
| `lm:{space}:{ns}:{id}:now` | hash, each field holds JSON |
| `lm:{space}:{ns}:{id}:log` | sorted set, score is the time in milliseconds |
| `lm:{space}:agent:{id}:recap` | string (JSON) |
| `lm:{space}:{ns}:list` | set, the index of ids |

`ns` is `agent`, `channel` or `job`. Managed accounts use the space `t-{id}`. Never write keys outside your space.

## 5. Moving from ACMI keys

1. Run the dry run: `node scripts/migrate-dry-run.mjs`. It maps `acmi:{space}:*` onto `lm:{space}:*`, reports the counts, and writes nothing.
2. The copy itself is not built yet: the script refuses `--apply`. When it ships, it will be copy-only, never rewrite `acmi:*`, and need a person's approval through **logmem-decisions**.
3. During the switch, run with `LOGMEM_ACMI_COMPAT=1` so LogMem also reads the old keys.

## 6. Pitfalls

- **The REST shape:** a bridge returns `{"result": ...}`. Unwrap `.result`.
- **The bridge allow list:** some commands return HTTP 403 by design (for example `PUBLISH`, `ZREMRANGEBYRANK`). Do not "fix" that by calling raw Redis from outside the host.
- **Env changes:** a container restart keeps the old env. Recreate the container to load new settings.
- **Slim Docker images** may not resolve `localhost`. Use `127.0.0.1`.
- **launchd:** `unload` does not stop a KeepAlive job that respawns. Use `launchctl bootout`, or remove the KeepAlive.
- **Scores:** a sorted-set write must keep the real millisecond score. A score of 0, or seconds, breaks ordering.
- **A memory fallback is not storage:** if the server says `degraded`, fix the backend before anyone writes more.

## Verify

1. `logmem_connection` shows your backend, the right space, and no `degraded: true`.
2. `logmem_note` to a test channel, then `logmem_view` on it, shows the entry.
3. `redis-cli --tls -u "<uri>" TYPE lm:<space>:channel:<id>:log` returns `zset`.
