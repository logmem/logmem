# ACMI recall index (`cloud/recall`)

Slice C of the ACMI Cloud backplane (`docs/cloud/BACKPLANE.md`). Redis is canonical. Qdrant is a derived index you can
rebuild from Redis at any time. There is one collection, `acmi_memory_v1`, shared by all tenants and isolated by the
`tenant_id` payload filter.

| File | What it does |
|------|--------------|
| `outbox.mjs` | `enqueue(redis, tenant, {ref, kind, ts})` does an RPUSH of `{ref, kind, ts}` to `acmi:{tenant}:outbox`, and nothing else |
| `refs.mjs` | The ref format, plus the default `loadEntry` (reads the canonical entry from Redis) |
| `redact.mjs` | `redact(text)` replaces secret-shaped strings with `[REDACTED]` |
| `chunk.mjs` | Splits text into chunks of about 800 characters, with 100 characters of overlap |
| `embed.mjs` | The embedder contract, plus `fakeEmbedder({dim})` for tests (deterministic, no network) |
| `qdrant.mjs` | `createQdrant({url, apiKey})` (plain fetch to the REST API) and `createMemoryQdrant()` (a test double) |
| `indexer.mjs` | `indexOnce` (drains the outbox), `rebuild` (rebuilds one tenant from Redis), `pointId` |
| `search.mjs` | `recall(...)` (tenant-filtered search plus hydration), `createRecallHandler` for `POST /v1/recall` |

## Refs

A ref points into the tenant's own namespace. It always starts with `lm:{tenant}:` or `acmi:{tenant}:`.

- **Log entry:** `{logKey}@{score}#{id}`. For example, `lm:acme:channel:ops:log@1791731538741#memoOps-1791731538741-9f…`.
  - `logKey` is a `lm:*:log` or `acmi:*:timeline` ZSET.
  - `score` is the member's raw ZSET score.
  - `id` is the entry's `trail` (or the ACMI `correlationId`). An entry with neither gets `h-` plus 16 hex characters
    of the sha256 of its stable JSON, with the `_o` ordinal left out.
  - Why the score is in the ref: a lookup becomes `ZRANGEBYSCORE key score score` instead of reading the whole log.
    A ref of only `{logKey}#{trail}` would force a full scan, because a ZSET member is the entire entry JSON.
- **Document:** the key itself, for string slots: `lm:*:who`, `lm:*:recap`, `acmi:*:profile`, `acmi:*:rollup:latest`.

Refs under `session`, `registry`, `ask`, `decision`, `oauth`, `outbox` and `cloud` are refused. A ref that looks like
it carries a secret is also refused.

A writer (the bridge or the server) enqueues the ref right after its ZADD or SET:

```js
import { enqueue } from "./cloud/recall/outbox.mjs";
import { logRef } from "./cloud/recall/refs.mjs";
await enqueue(redis, tenant, { ref: logRef(key, score, member), kind: entry.kind, ts: score });
```

## Points

- **Id:** a UUID built from `sha256(tenant|ref|chunkIndex)`. Re-indexing the same entry overwrites the same points.
  When an entry shrinks, its stale higher-index chunks are deleted.
- **Payload:** `{tenant_id, ref, kind, ts_ms, chunk, chunk_index, index_version: 1, content_hash}`.
  - `chunk` holds the redacted text, and `content_hash` is the sha256 of the redacted text.
- **Missing entries:** when a canonical entry no longer exists in Redis, its points are deleted the next time its ref
  is indexed. Recall also drops it at hydration time.
- **Failures:** a failed item is retried with exponential backoff (`backoffMs * 2^(n-1)`). The retry state is in
  `acmi:{tenant}:outbox:retry`.
- **Dead letters:** after `maxAttempts` failures (5 by default), the item goes to `acmi:{tenant}:outbox:dlq` as
  `{ref, kind, ts, attempts, error}`. `error` is a short code, never a message.

## Running against a real Qdrant

The secrets are `QDRANT_URL` and `QDRANT_API_KEY`. They live in Infisical (open question 6) and reach the process only
through env. Never put them in a file in the repo, a command line, a log or an ACMI event.

```bash
# Inject from Infisical; nothing is written to disk or echoed.
infisical run --env=prod --path=/acmi-cloud -- node --input-type=module -e '
  import { createQdrant } from "./cloud/recall/qdrant.mjs";
  import { indexOnce } from "./cloud/recall/indexer.mjs";
  import { fromDescriptor, descriptorFromEnv } from "./src/lib/backend.mjs";
  const redis = fromDescriptor(descriptorFromEnv(process.env));
  const qdrant = createQdrant({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });
  const embed = /* the chosen provider: see "Embedder" below */ null;
  for (;;) {
    const s = await indexOnce({ redis, qdrant, embed, tenant: process.env.ACMI_TENANT, log: (e) => console.log(JSON.stringify(e)) });
    if (!s.popped) await new Promise((r) => setTimeout(r, 2000));
  }'
```

The `log` callback receives only counts, error codes and a 12-hex sha256 prefix of the ref. It never receives text,
payloads or secrets, so you can send it to stdout.

### Payload indexes

You need the payload index on `tenant_id`. Every search filters on it. Without the index, Qdrant scans the whole
shared collection on every recall, and that slows down as tenants are added.

The first `indexOnce` (or `rebuild`) per process calls `ensureIndex`, which creates the collection (cosine distance,
`embed.dim`) if it is missing, plus these payload indexes:

- `tenant_id`: keyword, `is_tenant: true` (Qdrant ≥ 1.11 lays out storage per tenant)
- `ref`: keyword (used by per-entry deletes)
- `kind`: keyword
- `ts_ms`: integer

The `acmi-cloud` CLI (slice D) should also create them once at provisioning time. The calls are idempotent.

### Rebuild

```js
await rebuild({ redis, qdrant, embed, tenant });   // deletes tenant_id == tenant, re-enqueues every canonical entry
while ((await indexOnce({ redis, qdrant, embed, tenant })).popped) {}
```

Rebuild walks `lm:{t}:*:log`, `acmi:{t}:*:timeline` and the string doc slots with `SCAN`. After a migration copy, an
entry can exist under both `lm:` and `acmi:`. In that case both are indexed, under different refs.

## Embedder

No provider is chosen yet. Mikey picks one (open question 2). An embedder is `async (texts: string[]) =>
number[][]`, with an integer `dim` property. The indexer passes it only redacted text. Changing the model or the
dimension requires a new collection (`acmi_memory_v2`) and a rebuild for every tenant. `ensureCollection` refuses a
dimension mismatch.

## Recall API

`POST /v1/recall` with the header `Authorization: Bearer <ACMI key>` and the body `{query, limit?, kinds?, since?}`.

- **Auth:** `verifyKey(redis, token)` comes from slice A and returns `{tenant, keyid}` or `null`. A `null` result, or
  an error, gives a `401 {"error":"unauthorized"}`.
- **Filter:** the server always searches with `must: [{tenant_id == tenant}, kinds?, ts_ms >= since?]`. The handler
  ignores any `filter`, `tenant`, `tenant_id` or `collection` field in the request body.
- **Hydration:** each hit is hydrated from Redis. Refs that are missing or deleted are dropped. The response is
  `{results: [{ref, kind, ts, score, entry}]}`.
- **Metering:** `meter(redis, tenant, "recall", 1)` from slice A runs only after a successful recall.
- **Errors** are generic codes: `unauthorized`, `bad_request`, `method_not_allowed`, `internal_error`.
