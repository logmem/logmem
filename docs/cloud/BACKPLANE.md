# ACMI Cloud backplane: design (2026-10-13)

The hosted product, built on the approved Elestio VM backplane. Sources: the Elestio Backend Recap (Drive, 2026-10-13),
the LogMem Cloud PRD (in Muse's workspace, not yet in this repo), Decision 3 (MIT open core) and Mikey's directive of
2026-10-13.

**Public naming is ACMI** until the code and package rename lands. Every name a customer can see uses ACMI: binaries,
packages, env vars, API paths, headers, error messages and docs. Internal code in this repo may still say LogMem.

## Rules (from the directive, non-negotiable)

1. **Redis is canonical.** Every write lands in Redis first. Nothing is true only in Qdrant.
2. **Qdrant is the derived recall index.** It is rebuildable from Redis at any time. One collection, filtered by
   `tenant_id` in the payload (Decision 0004).
3. **Meter operations, not seats.** Adds, reads and recalls, per tenant per month, enforced against plan quotas.
4. **Isolate tenants twice:** by Redis key namespace and by Qdrant payload filter. A tenant credential can never
   name another tenant's namespace. **Tenant namespace = `t-{id}`**: keys live under `acmi:t-{id}:` and `lm:t-{id}:`,
   and the Qdrant `tenant_id` is the bare `{id}`. The `t-` segment is never used by fleet or system keys (verified
   against live Redis on 2026-10-13), so no tenant id can land on `acmi:agent:`, `acmi:work:`, `lm:oauth:` and
   similar trees (review of PR #28, finding M1). Use `namespaceFor(id)` from cloud/tenants; never build the prefix
   by hand.
5. **One bridge binary per tenant.** Each tenant gets its own `acmi-bridge` process with its own token. It can only
   touch its own namespace.
6. **No secrets in events, signals or timeline entries.** Tokens and keys live in Infisical and process env only.
   Logs carry key ids or hash prefixes, never values.

## Components

```
customer agents ──MCP/HTTP──▶ acmi-bridge (one per tenant, token T_t)
                                 │  jail: keys must start with acmi:t-{tenant}:  (and lm:t-{tenant}:)
                                 │  command allowlist, size caps, rate limit
                                 │  meter: INCR acmi:cloud:meter:{tenant}:{yyyymm}:{op}
                                 ▼
                           Redis/Valkey (shared VM, canonical)
                                 │  outbox: acmi:t-{tenant}:outbox (stream/list)
                                 ▼
                           acmi-indexer ──embed──▶ Qdrant collection acmi_memory_v1
                                                    payload: tenant_id, ref, kind, ts…
control plane (acmi-cloud CLI + API): tenants, plans, keys, provisioning, quotas
```

### 1. Tenant registry (control plane, `cloud/tenants`)
- `acmi:cloud:tenant:{id}` hash holds `id, name, plan, status, created_at, namespace, bridge_port, key_ids`. Tenant
  ids are `^[a-z][a-z0-9-]{2,30}$`. Reserved, as defence in depth on top of the `t-` namespace: `madez`, `cloud`,
  `probe`, `admin`, `system`, `agent`, `work`, `thread`, `bus`, `user`, `oauth`, `onboard`, `fieldnotes`,
  `registry`, `tenant`, `inbox`, `relay`, `acmi`, `lm`, `logmem`, `mcp`, `api`, `www`, `t`.
- **API keys.**
  - Format: `acmi_live_<keyid>_<secret>`.
  - The registry stores only `sha256(secret)` and metadata, keyed by `keyid`.
  - Keys are created, listed (metadata only), rotated (old and new valid for a grace window) and revoked.
  - Compares use `timingSafeEqual`.
- **Plans** are data, not code: `cloud/plans.json`. Default numbers follow the PRD (Starter $49, Pro $99,
  Scale $199). Quotas are per op per month, and the file is easy to change.

### 2. Metering and quotas (`cloud/meter`)
- **Ops:** `add` (any write), `read` (any read command), `recall` (vector search), `ops_total`.
- **Counter:** `INCRBY acmi:cloud:meter:{tenant}:{yyyymm}:{op}`, with the TTL at 400 days.
- **Quotas:** soft cap at 100%, plus a 10% grace margin. After that, writes are refused with `quota_exceeded` and
  reads still work. This matches docs/PRICING.md's rule that writes are never dropped silently.
- **Exports:** a usage summary per tenant per month, for billing later. Billing itself is out of scope (open
  question 1).

### 3. `acmi-bridge` (one per tenant, `cloud/bridge`)
- **Interface:** a single Node 22 file with no dependencies. It speaks the Upstash REST shape the fleet already uses
  (`POST /exec` with a JSON command array, `POST /pipeline`), so existing adapters (`redis-rest.mjs`, ACMI's Upstash
  adapter) work unchanged.
- **Config from env only:**
  - `ACMI_TENANT`, `ACMI_BRIDGE_TOKEN_SHA256` (the hash of the token, not the token)
  - `ACMI_REDIS_URL` (internal network)
  - `ACMI_BRIDGE_PORT`, `ACMI_PLAN_QUOTAS`
- **Jail:**
  - Every key argument (resolved per command from a table) must start with `acmi:t-{tenant}:` or `lm:t-{tenant}:`.
  - Cross-key commands (`RENAME`, `SMOVE`, `ZUNIONSTORE`…) check every key.
  - `SCAN` and `KEYS` get a forced `MATCH` prefix.
  - Not allowed: `EVAL`, `SCRIPT`, `FLUSH*`, `CONFIG`, `CLIENT`, `MODULE`, `MONITOR`, `SELECT`, `MIGRATE`,
    `DEBUG`, `KEYS *` without a prefix.
- **Limits:** body ≤ 1 MB, value ≤ 512 KB, pipeline ≤ 100 commands, per-token rate limit, constant-time token check,
  generic errors, no echo of arguments in errors.
- **Metering:** each command is classified add / read and counted. Quota enforcement goes through the shared meter
  module.
- **Health:** `GET /health` returns `{ok, tenant, version}` with no auth and no data.
- **Ships with** a Dockerfile and an Elestio compose template with one service per tenant, generated by the
  control plane.

### 4. Recall (`cloud/recall`)
- **Outbox:** the bridge (or the server) appends `{ref, tenant, kind, ts, text_hash}` to `acmi:t-{tenant}:outbox`.
  Only refs and hashes go in, never secret-bearing payloads.
- **Indexer:**
  - Reads the outbox, loads the canonical entry from Redis, then redacts secret-shaped strings (same patterns as the
    repo secret scan).
  - Chunks and embeds the text, then upserts into `acmi_memory_v1` with a deterministic point id
    `sha256(tenant|ref|chunk)`.
  - Payload: `tenant_id, ref, kind, ts_ms, entity, index_version, content_hash`.
  - Retries with backoff, sends failures to a dead-letter list, and supports a rebuild from Redis.
- **Search API:**
  - `POST /v1/recall {query, limit, kinds, since}`, authed by tenant key.
  - The server always adds `must: tenant_id == T`; the caller can't override it.
  - Returns refs, then hydrates them from Redis, the source of truth, and drops anything missing or deleted.
- **Embedder** is pluggable: a deterministic fake for tests. A real provider needs Mikey's pick; none is wired
  until then.

### 5. Provisioning (`cloud/cli`: `acmi-cloud`)
- **`tenant create <id> --plan starter`** writes the registry entry and makes the first API key, which is shown
  once to the operator and never logged. It also generates the bridge token and stores only its hash. It renders the
  compose service and creates the Qdrant payload index on `tenant_id`, once per collection.
- **Other commands:** `tenant suspend|resume|delete` (delete is a dry run by default) and
  `keys create|rotate|revoke`. `usage <id> [--month]` prints usage, and `bridge render <id>` prints the compose
  snippet.
- **Secrets:** the CLI writes secrets only to stdout (shown once) or to a 0600 file the operator names. The operator
  then moves them to Infisical.

## Out of scope for this build
- Stripe billing.
- The onboarding agent's conversation layer. Onboarding v2 and the probe are the front door, and the agent comes
  later.
- Running any of this on Elestio (spend and access are gated on Mikey).
- Choosing a real embedding provider.
- Renaming code or packages.

## Open questions (carried from the recap)
1. Does Vercel stay the API edge, or does Elestio replace it fully? This build is edge-agnostic: the bridge and
   indexer run anywhere.
2. Which embedding provider and model?
3. Free-pilot abuse controls.
4. Pricing. The PRD's $49/$99/$199 and docs/PRICING.md's Free/Dev ladder differ; `plans.json` holds whichever
   Mikey picks.
5. "Osteo": confirm the name and scope.
6. Qdrant firewall and `QDRANT_API_KEY` in Infisical (still pending).

## Build order
- **A.** Tenant registry, keys, plans, meter and quota (library plus tests).
- **B.** acmi-bridge with jail, allowlist, limits and metering (binary, tests, Dockerfile, compose template).
- **C.** Recall: outbox, indexer and search with tenant filter (fake embedder, in-memory Qdrant double, tests).
- **D.** The acmi-cloud CLI, which ties A to C together.

Each slice ships as its own PR into `feat/site-pass-a`, with an independent review before merge.
