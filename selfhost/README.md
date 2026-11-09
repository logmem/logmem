# Run your own LogMem (self-host bundle)

One command gives you a private LogMem: the web app, the MCP endpoint, your
own Redis, and credentials you generate on your machine.

```bash
./selfhost/install.sh          # first space is "main"
./selfhost/install.sh myteam   # or name your first space
```

Then open <http://127.0.0.1:3899/keys> and sign in with the admin password
that install.sh wrote to `selfhost/.env`. (`/keys` redirects to the Agent
access screen.)

## What runs

| Service | Image | Published |
|---|---|---|
| `server` | built from this repo (`selfhost/Dockerfile`) | `127.0.0.1:3899` |
| `redis` | `redis:7-alpine` | `127.0.0.1:6399` (for your `redis-cli` and backups) |

The server is one node process (`selfhost/serve.mjs`). It serves the same
surface as logmem.si: static app from `public/`, API routes from `api/`, the
rewrites and security headers from `vercel.json`.

**No bridge container.** The cloud bridge (`cloud/bridge`) is jailed to
`acmi:t-{tenant}:` / `lm:t-{tenant}:` namespaces. It structurally cannot
touch a personal instance's `lm:{space}:*` keys, so shipping it would add a
service with no door to your data. Your remote door is the server itself:
`/api/mcp` for MCP clients, `/api/view` and the rest of the API behind your
admin sign-in.

## Requirements

- Docker with compose v2
- `openssl` and `curl` (install.sh uses both)

## What install.sh does

1. Writes `selfhost/.env` (mode 600) with fresh credentials, once:
   redis password, admin password, decide secret, OAuth KEK, cron secret.
   The file is git-ignored. Nothing is generated in this repo or shipped to
   you.
2. `docker compose up -d --build` for server + redis.
3. Waits for `GET /api/health` and verifies admin sign-in with a real
   `POST /api/login`. It never prints the password.

Re-running install.sh keeps your existing `.env` and just starts the stack.

## Security model

- **Loopback only.** Both ports publish on `127.0.0.1`. Nothing listens on
  your LAN unless you edit `docker-compose.yml`.
- **Your credentials.** All secrets are generated into `selfhost/.env` on
  your machine. Keep it `chmod 600`, never commit it.
- **Plaintext Redis is local.** Redis runs on the compose network with a
  password, published on loopback. That is why `.env` sets
  `LOGMEM_OAUTH_ALLOW_INSECURE=1` — the designed local hatch. Never set it
  on a hosted deployment.
- **Read-only container.** The server runs as user `node` with a read-only
  filesystem and `no-new-privileges`.
- **No Clerk needed.** Without Clerk keys, sign-in is the admin password
  (`/keys`). Set `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` in `.env` if
  you want the customer-facing screens too.

## Cron jobs

Production runs `api/cron/*` on Vercel's clock. The bundle does not
schedule them. Run them from your host when you want them:

```bash
# from the repo root, after install
source selfhost/.env
curl -X POST "http://127.0.0.1:${SERVER_PORT}/api/cron/reconcile" \
  -H "Authorization: Bearer $CRON_SECRET"
# same for /api/cron/dogfood-check and /api/cron/fleet-truth
```

## Backup and restore

Redis keeps an AOF (`--appendonly yes`). To snapshot:

```bash
source selfhost/.env
docker compose -f selfhost/docker-compose.yml exec redis \
  sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SAVE'
docker compose -f selfhost/docker-compose.yml cp redis:/data/dump.rdb ./logmem-backup.rdb
```

Restore by stopping the stack, replacing the `redis-data` volume contents
with your `dump.rdb`, and starting again.

## Update

```bash
git pull
docker compose -f selfhost/docker-compose.yml up -d --build
```

Your `.env` and the redis volume are untouched.

## Ports taken?

Pick different ones before the first start:

```bash
cd selfhost
SERVER_PORT=4444 REDIS_PORT=6398 ./install.sh
```

`install.sh` also honors those two environment variables on later runs when
it re-reads `.env`.

## How this is tested

`test/selfhost-serve.test.mjs` boots the real `serve.mjs` listener on an
ephemeral port against a REST stub and asserts the surface: health 200,
static first, vercel.json headers on every path, `/mcp` and `/api/pulse`
rewrites, admin login, agent-key mint, 404s and traversal refusal. The
`docker compose` path itself needs a Docker daemon; run install.sh on a
machine with Docker to see the full loop.
