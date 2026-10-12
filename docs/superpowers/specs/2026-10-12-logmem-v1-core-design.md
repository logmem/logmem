# LogMem v1 core: design (Tier 1)

Date: 2026-10-12 · Status: **DRAFT for owner review** · Covers GAPS.md D1–D5, U5, U6, U8 · Supersedes the
"Entry shape" and "Key layout" parts of `docs/KEYS.md` and §3–§4 of `docs/spec/tools.md` once accepted.
Docs only. Nothing here has been built, deployed or run against any Redis.

## 0. Decisions at a glance

| # | Decision |
|---|---|
| D1 | Every entry gets a server-generated **ULID `id`**, a schema version **`v: 1`** and a **space-wide `seq`** (`INCR`). Bodies live once per space in `lm:{s}:entries` (HASH id → JSON); every log is a ZSET of **member = id, score = ts ms**. Content dedupe and `_o` go away. Retries dedupe on `id`; clients dedupe with `idempotency_key`. Entries are immutable; the only in-place change is a human **redaction** that leaves a tombstone |
| D2 | Seven Lua scripts (`append`, `handoff`, `accept`, `ask`, `decide`, `shift`, `redact`) plus a read script (`page`) sharing one prelude. The runner gains `script()` (EVALSHA, NOSCRIPT → EVAL) and `pipeline()`. A capability probe picks **atomic** or **sequenced** mode; hosted requires atomic |
| D3 | Contract **1.0**: cursors on every list read, `id` + `idempotency_key` on every write, `logmem_accept`, `logmem_pending`, human-only `logmem_decide` with `verdict`, `to` validated against the roster, coded errors, contract version in `initialize` |
| D4 | Keys are `lm:{space}:…` (hash tag). No SCAN on any request path: an activity ZSET, a log index, open-item indexes and shift indexes replace it. Redis is the hot store; **Postgres** holds the registry, history, search and export (hosted, and BYO by opt-in). Isolation is enforced by the LogMem server, not by Redis, and this doc says so plainly |
| D5 | Hot window **30 days** (free) / **90 days** (team, agency); older archived entries leave Redis. Mirror off target **2026-12-01**; compat reads removed **no earlier than 2027-01-15, no later than 2027-03-31**, only when the conditions in §6 hold |

---

## 1. D1: entry identity and storage

### 1.1 Entry shape (v1)

```jsonc
{
  "seq": 4182,                          // space-wide commit order, injected by the script
  "v": 1,                               // entry schema version
  "id": "01JA7Q8K3M5V2C9RZB6T4XWDHN",   // ULID; first 10 chars encode ts
  "ts": 1791731538741,                  // ms; always equal to the ULID time
  "kind": "handoff",
  "by": "agent:quill", "via": "codex", "byline": "quill (via codex)",
  "shift": "quillShift-1791731500000",
  "trail": "handoffIssue14-1791731538741",
  "origin": "assignedIssue14-1791731400000",
  "logs": ["job:issue-14", "agent:atlas"],   // every log this entry is indexed in
  "summary": "...",
  "payload": {},                        // optional, ≤ 8 KB
  "to": "agent:atlas"                   // kind-specific fields as in v0
}
```

- `id`: ULID generated in Node (monotonic within a process, ~30 lines, no dependency). The server, not the
  client, mints it. `ts` comes from the same clock read, so `id` order equals `(ts, id)` order.
- `seq`: one counter per space, `lm:{s}:seq`. An entry fanned out to three logs has **one** seq. It is the
  outbox cursor (§4.4), the activity order and the gap detector (`seq` gaps mean a lost write).
- `v`: readers treat a missing `v` as 0 (v0 `lm` or legacy ACMI) and upgrade on read.
- Limits (S7): `summary` ≤ 500 chars, encoded entry ≤ 16 KB, refused with `too_large`.
- Client-supplied `ts` is dropped from the v1 contract. Only the import/migration path may backdate, and it
  mints the ULID from that `ts`.

**Rejected: a per-log sequence** (GAPS suggested it). A fanned-out entry would carry a different number in
each log, so it can't serve as one identity or one outbox cursor. Per-log counts are `ZCARD`.
**Rejected: Redis Streams.** You can't backdate IDs for migration, entries can't be replaced in place
(redaction), `XRANGE` over many streams is no better than ZSETs, and the ACMI timeline is a ZSET already.
**Rejected: client-generated ids.** They invite collisions and forged ordering. Clients get
`idempotency_key` instead.

### 1.2 Storage layout

| Key | Type | Member / value | Score |
|---|---|---|---|
| `lm:{s}:entries` | HASH | `id` → entry JSON (with `seq`) | |
| `lm:{s}:seq` | STRING | INCR counter | |
| `lm:{s}:{ns}:{id}:log` | ZSET | entry `id` | `ts` ms |
| `lm:{s}:activity` | ZSET | entry `id` | `seq` |
| `lm:{s}:idem:{h}` | STRING | `"<id>|<req_hash>"`, `EX 86400` | |

There is one body per entry, however many logs it sits in. That fixes the "shown once" signature hack in
`view.mjs` (`ts|trail|summary`) and makes redaction a single write.

**Rejected: keep member = JSON.** Redaction and edits would mean ZREM + ZADD on every log holding a copy.
Dedupe stays content-based (that is today's `ZRANGEBYSCORE ts ts` loop, a read-then-write race). Members are
large, so `ZRANGE` pages are large.
**Rejected: one STRING key per entry.** That's millions of keys, ~60 B overhead each, and it pushes
operators back to SCAN. The HASH is in the space's slot and trims with `HDEL`.

### 1.3 Ordering and cursors

A log orders by `(score = ts, member = id)`. Redis orders equal scores by member bytes, and the ULID random
part breaks ties, so the ZSET order is the display order. No `_o` is needed.

Cursor = `base64url(JSON {"c":1,"ts":<ms>,"id":"<ulid>","d":"rev"|"fwd"})`, opaque to clients and exclusive.
The `page` script (§2.2) reads `ZRANGE key <ts> -inf BYSCORE REV LIMIT 0 <n+t>`, where `t` = `ZCOUNT key ts ts`,
drops members with `score == ts and member >= id`, then `HMGET`s the bodies. Multi-log reads (`feed`) merge by
the same `(ts, id)` key, so one cursor works across logs. Cursors aren't signed: tampering only exposes your
own space.

**Rejected: score 0 + `BYLEX` on the ULID.** Cursors get simpler, but you lose `ZREMRANGEBYSCORE` retention,
`ZCOUNT` windows, readable scores in `redis-cli`, and parity with the ACMI timeline that the mirror and compat
read.

### 1.4 Dedupe and idempotency

- **Transport retries** (REST fetch timed out after Redis applied it): the Node side minted `id` before the
  call. A retry sends the same `id`, and the script returns the stored entry (`{0, id, body}`) when `HEXISTS entries id`. So
  internal retries are exactly-once.
- **Client retries**: optional `idempotency_key` (≤ 128 chars) on every write tool.
  `h = sha256(tool ‖ agent ‖ key)[:32]`, and `req_hash = sha256(canonical args without the key)`. Same key,
  same args → the original result with `deduped: true`. Same key, different args → `idempotency_conflict`.
  The TTL is 24 h.
- **Content dedupe is removed.** Two identical notes are two entries. That was already true whenever `ts`
  differed by 1 ms, so nothing real relied on it.

### 1.5 Edits and redaction

- Entries are **immutable**. A correction is a new entry: `kind: "fix"`, `amends: "<id>"`, `origin` = the
  original's trail. Readers show `amended_by` when both are on the same page. There's no edit tool.
- Derived state that v0 kept in entries moves to indexes: `approval.status: "waiting"` becomes membership of
  `open:ask` (§5.2).
- **Redaction (GDPR erasure of one entry)** is human-only, through `POST /api/spaces/{s}/entries/{id}/redact`
  (admin auth now, approver/owner role after U7). The `redact` script replaces the body with a tombstone and
  keeps the chain:
  `{"seq","v","id","ts","kind","by","trail","origin","logs","redacted":{"at","by","reason_code"}}`. `summary`,
  `payload`, `action` and kind-specific text are dropped. The tombstone keeps the original `seq`. The redaction itself takes a new
  `seq` as its score in `lm:{s}:redactions`, so the outbox propagates it to Postgres and the archive (§6.2). The mirror replaces the
  ACMI twin, which it finds exactly via `ZRANGEBYSCORE acmi…:timeline ts ts` + `lm_id`. A `fix` audit entry
  records the redaction **without** the redacted text.
- `logmem_remove` stops accepting `:log` keys in v1 (`invalid_argument`, pointing to redaction or retention),
  because deleting a log ZSET would orphan bodies.

### 1.6 Migration from v0 (member-is-JSON + `_o`)

The hash tag makes the v1 key space disjoint from v0 (`lm:{madez}:…` vs `lm:madez:…`), so v0 and v1 never mix
in one ZSET.

`scripts/migrate-v0-v1.mjs` has three modes. `--dry-run` is read-only, using the existing allowlist.
`--apply` is HITL. `--verify` checks the result.

1. For each v0 log (from the `lm:madez:{ns}:list` sets, not SCAN), read the members, parse them, strip
   `_o`, and sort by `(ts, _o)`.
2. Group identical `(ts, trail, summary, by)` across logs into **one** entry with `logs: [...]`. That's the
   v0 handoff/ask fan-out.
3. Mint the ULID from `ts` (monotonic in `_o` order) and assign `seq` in global `(ts, _o)` order.
4. Write the bodies, log ZSETs, activity, open indexes (§5.2) and shift indexes (§5.1). Who/now/recap/
   follows/shifts/sessions are copied as-is.
5. `--verify`: per log, `ZCARD v1 == distinct v0 members`; every id resolves; no `seq` gaps; no score outside
   ms. The dry-run report hash must match the `--apply` confirmation (same pattern as `PLAN.md`).

The ACMI `--apply` (PLAN.md step 2) targets the **v1** shape directly, with the same grouping and
`acmi_kind` preserved. v0 `lm:madez:*` keys stay for 30 days, and removing them is a separate HITL task.

---

## 2. D2: atomic write path

### 2.1 Scripts

Every script includes a shared prelude. All keys share the `{s}` slot, so the scripts are cluster-safe.
`acmi:*` keys are in a different slot, which is one reason the mirror stays outside Lua (§2.4).

Common KEYS **C** = `[entries, seq, activity, logs_index, idem, shift_idx]`.
Common ARGV **A** = `[id, ts, body, req_hash ('' = no idempotency key), idem_ttl, shift_ttl]`.
`body` is the entry JSON **without** `seq`, starting with `{"v":1,`.

```lua
-- prelude
local function core(K, A, logKeys, refs)
  if redis.call('HEXISTS', K[1], A[1]) == 1 then        -- transport retry
    local e = redis.call('HGET', K[1], A[1]); return {0, A[1], e} end
  if A[4] ~= '' then
    local prev = redis.call('GET', K[5])
    if prev then
      local pid, ph = string.match(prev, '([^|]+)|(.*)')
      if ph ~= A[4] then return {-1, 'idempotency_conflict'} end
      return {0, pid, redis.call('HGET', K[1], pid)}
    end
  end
  local seq = redis.call('INCR', K[2])
  local full = '{"seq":' .. seq .. ',' .. string.sub(A[3], 2)   -- no cjson round trip
  redis.call('HSET', K[1], A[1], full)
  redis.call('ZADD', K[3], seq, A[1])
  for i, lk in ipairs(logKeys) do
    redis.call('ZADD', lk, A[2], A[1])
    redis.call('ZADD', K[4], A[2], refs[i])                -- log index: last activity
  end
  redis.call('ZADD', K[6], A[2], A[1]); redis.call('EXPIRE', K[6], A[6])
  if A[4] ~= '' then redis.call('SET', K[5], A[1] .. '|' .. A[4], 'EX', A[5]) end
  return {1, A[1], full}
end
```

The prelude splices `seq` into the body as a string so cjson never re-encodes it. cjson turns `[]` into `{}`
and reformats numbers.

| Script | Extra KEYS (after C) | Extra ARGV (after A) | Checks → effects |
|---|---|---|---|
| `append` (note, update, stage, assign, status-with-entry) | `now_hash` (or a dummy key in the slot), `log…` | `now_pairs_json` (`[]` = none), `ref…` | → core; `HSET now` pairs |
| `handoff` | `agent_list`, `open:handoff:{to}`, `follows:{to}`, `job_now` (or dummy), `log…` (where + receiver) | `to`, `follows_json`, `owner_pairs_json`, `ref…` | `to` ∈ `agent:list` (SISMEMBER) else `unknown_agent` → core; `ZADD open:handoff:{to} ts id`; `HSET follows`; `HSET job now owner, handoff_id` |
| `accept` | `open:handoff:{me}`, `log…` (handoff's where + my log) | `handoff_id`, `ref…` | `ZSCORE open:handoff:{me} handoff_id` else `not_open` → core; `ZREM` |
| `ask` | `open:ask`, `asker_now`, `log…` | `waiting_on_json`, `ref…` | → core; `ZADD open:ask ts id`; `HSET now waiting_on` |
| `decide` | `open:ask`, `asker_now`, `answered:{asker}`, `log…` | `ask_id`, `verdict`, `ref…` | `ZSCORE open:ask ask_id` else `already_decided`; `verdict ∈ {approve,reject}` → core; `ZREM open:ask`; `HDEL waiting_on` only if it names `ask_id`; `ZADD answered`, trimmed to 50 |
| `shift` (auto Start, idle/switch Recap, manual Recap) | **replaces C**: `session`, `entries`, `seq`, `activity`, `logs_index`, `old_shift_idx`, `new_shift_idx`, `old_agent_log`, `new_agent_log`, `old_recap`, `new_shifts` | `expected_ver`, `new_rec_json`, `session_ttl`, `recap_id`, `recap_ts`, `recap_body` ('' = none), `recap_doc`, `start_id`, `start_ts`, `start_body` ('' = none), `shift_member`, `shift_ttl` | `session.ver == expected_ver` else `{0, current}` (lost the race: caller adopts the winner's record) → up to two core appends; `SET recap`; `ZADD shifts`; `SET session` (ver+1) `EX ttl` |
| `redact` | `entries`, `seq`, `redactions` | `id`, `tombstone_json` | `HEXISTS` else `not_found` → `INCR seq`; `HSET` tombstone; `ZADD redactions seq id` |

### 2.2 Reads

`page` (read-only script): KEYS = up to 16 log ZSETs + `entries`. ARGV = `dir, cursor_ts, cursor_id, limit`.
It merges by `(ts, id)` and returns `[bodies…, next_cursor]` in **one** round trip. Without scripts it takes two
pipelined round trips: the `ZRANGE … LIMIT`s, then one `HMGET`. Brief, View and Open batch their
who/now/recap/follows/shifts reads into one `pipeline()`.

### 2.3 Runner abstraction

The runner is still `redis(cmd, ...args)`, with two optional methods:

```js
runner.script(name, keys, args)  // EVALSHA sha(name) → on NOSCRIPT: EVAL src (REST) / SCRIPT LOAD + EVALSHA (TCP)
runner.pipeline(cmds)            // REST: POST {base}/pipeline; TCP: client.multi().execAsPipeline(); else Promise.all
runner.caps                      // { scripts: "atomic"|"sequenced", pipeline: bool, probed_at }
```

- **Upstash REST**: `["EVALSHA", sha, n, ...keys, ...args]` on the normal endpoint, and `/pipeline` for
  batches. SHA1s are computed from the bundled sources when the module loads.
- **node-redis** (`redis-native.mjs`): add a `default:` passthrough to `client.sendCommand([...])` so
  EVAL/EVALSHA/SCRIPT/ZRANGE … BYSCORE REV LIMIT work without per-command translation.
- **Memory** (tests, degraded): scripts run through a **JS implementation of each script**. It's the same
  code as the sequenced fallback (§2.4), so it gets tested against real Lua in CI.

### 2.4 When a bridge blocks EVAL

**Capability probe**, run once per backend descriptor (stdio at boot; HTTP cached 10 min per warm instance):
`EVALSHA <sha("return 1")> 0`. NOSCRIPT or `1` means scripts are allowed. HTTP 403 or "not allowed" means they
aren't. Then `POST /pipeline [["PING"]]`. The result is reported in `logmem_connection.capabilities` and
`initialize`.

| Mode | When | Behaviour |
|---|---|---|
| `atomic` | scripts allowed | as above |
| `sequenced` | scripts refused, `LOGMEM_REQUIRE_SCRIPTS` unset | The JS twin of each script runs the same steps in a fixed, crash-safe order: body `HSETNX` first, then indexes, then the idempotency key, so a crash leaves a body without indexes and never an index without a body. Checks become check-then-write. Races are settled deterministically: **lowest `seq` wins** for accept and decide, and a later duplicate is re-marked `superseded_by` on read. Results carry `atomic: false` |
| refuse | scripts refused and `LOGMEM_REQUIRE_SCRIPTS=1` (**default for hosted**) | writes return `backend_refused` (non-retryable) |

A nightly `repair` (v1.1) re-indexes orphaned bodies by checking that each `activity` member resolves and each
body's `logs` contains it. The Polar bridge already blocks PUBLISH and ZREMRANGEBYRANK, so `madez` may land in
`sequenced` (owner question 1).

**Rejected: MULTI/EXEC.** It's not available over a plain REST exec, and it can't express "check, then
write". **Rejected: Redis Functions (`FCALL`).** They're cleaner, but need Redis 7 and a `FUNCTION LOAD`
deployment step per backend, which BYO users won't do.

---

## 3. D3: tool contract 1.0

### 3.1 Version

- `serverInfo = { name: "logmem", version: "1.0.0" }`. The `initialize` result adds
  `capabilities.experimental["logmem/contract"] = { version: "1.0", entry_schema: 1, writes: "atomic"|"sequenced", pipeline, search: "keyword"|"fts" }`.
- The first line of `instructions` names the contract (`LogMem contract 1.0.`).
- `tools.schema.json` gains a top-level `"contract": "1.0"`, and `spec:check` fails on mismatch.
- The minor version only adds. A major bump renames or removes. Deprecations live at least one minor version.

### 3.2 Common shapes

| Rule | Shape |
|---|---|
| List reads | in: `limit` (default/max per tool), `cursor`; out: `next_cursor` (string or `null` at the end) |
| Writes | in: `idempotency_key?`; out: `id`, `seq`, `deduped`, `atomic` |
| Refs to entries | anywhere v0 takes a trail to point at one entry (`origin` stays a trail), v1 also takes `id` |
| Errors | `{ ok:false, tool, code, error:"<message>", retryable, details? }` with `isError: true`. `error` stays a string, so v0 readers keep working |

Error codes: `invalid_argument`, `not_found`, `unknown_agent`, `reserved_kind`, `not_open`, `already_accepted`,
`already_decided`, `idempotency_conflict`, `forbidden`, `too_large`, `quota_exceeded`, `rate_limited`,
`backend_unavailable` (retryable), `backend_refused`, `degraded`, `internal`.

### 3.3 Tools

| Tool | Change in 1.0 |
|---|---|
| `logmem_start` | goes through the `shift` script; result adds `brief.pending` |
| `logmem_brief` | `log` limit 20 (max 50) + `next_cursor`; `handoffs_to_me` from `open:handoff:{me}` (never ages out); new `my_asks` (`waiting_on` + answered via `answered:{me}`, with `verdict`) |
| `logmem_recap` | reads the shift index (§5.1); `idempotency_key` |
| `logmem_note` | `idempotency_key`; `kind: "decided"` → `reserved_kind`; `kind: "accepted"` still works and routes through `accept` with a `deprecation` field (removed in 2.0) |
| `logmem_handoff` | `to` must be on the roster, else `unknown_agent` with `details.did_you_mean`; returns `id` |
| `logmem_accept` **new** | in: `handoff` (id or trail), `note?`, `idempotency_key?`. Only the addressee (`to`) can accept; second accept → `already_accepted` |
| `logmem_ask` | returns `id`; no `status` field written; `idempotency_key` |
| `logmem_pending` **new**, R | in: `of` ∈ `handoff`·`ask`, `to?` (default me, for handoffs), `limit` 20/100, `cursor`. Reads open-item indexes |
| `logmem_decide` **new**, human-only | in: `ask` (id), `verdict` ∈ `approve`·`reject`, `comment?`. Listed only when the connection's principal is a human with the approver role. Agent connections never see it, and the web Approve/Reject (U3) calls the same core function. Writes `kind: decided`, `by: human:<id>`, `decides: <ask id>` |
| `logmem_status`, `logmem_bio`, `logmem_follow` | `idempotency_key` (they are idempotent anyway); unchanged otherwise |
| `logmem_view` | `limit` 10/100, `cursor` |
| `logmem_feed` | `refs` ≤ 16, `limit` 50/200, `cursor`; `since` kept |
| `logmem_roster` | `limit` 200/1000, `cursor` (SSCAN); `ids` unchanged |
| `logmem_assign`, `logmem_update`, `logmem_stage` | `idempotency_key`; `append` script (now + entry atomic) |
| `logmem_open` | `limit` 50/200, `cursor` |
| `logmem_jobs` | `limit`/`cursor`; returns `jobs: [{id, title, stage, owner}]` (breaking: v0 returned bare ids) |
| `logmem_recall` | `limit` 5/50; result `mode` ∈ `keyword`·`fts`; bounded scan (§5.3) |
| `logmem_remove` | refuses `:log` keys (§1.5) |
| `logmem_spaces`, `logmem_connection` | `connection` adds `contract`, `capabilities`, `schema_version` |

That makes 23 tools for agents, 24 for approvers. `acmi_*` compat tools are unchanged.

**Rejected: `decided` stays an agent-writable kind, with server checks on `by`.** `by` is self-asserted (S2).
The only fix is that agents can't reach the write path at all. **Rejected: hard-blocking the asker's writes
while an ask is open (O3).** Moved to v1.1. v1.0 puts `waiting_on` into every write result for the asker.

### 3.4 Deprecations from v0

`note kind:accepted` (use `accept`), `note kind:decided` (refused), approval `status` field (derived), client
`ts` (dropped), unbounded `feed` (capped), `remove` on log keys (refused), bare-id `jobs` (objects), `_o` in
entries (gone). Each deprecated path that still works returns `deprecation: "<what to use>"`.

---

## 4. D4: hosted layout

### 4.1 Keys

`lm:{space}:…`, where `{space}` is a Redis Cluster hash tag, so one space lives in one slot and every script
is cluster-legal. Space names now forbid `{`, `}` and `:`. Namespaces may not be reserved words: `entries seq
activity logs shift open answered idem redactions outbox meta session mirror registry`.

| Key | Purpose |
|---|---|
| `lm:{s}:logs` | ZSET `"ns:id"` → last ts. Replaces `SCAN lm:{s}:*:log` |
| `lm:{s}:shift:{shift}` | ZSET entry ids written in a shift, TTL 30 d (U5) |
| `lm:{s}:open:handoff:{agent}`, `lm:{s}:open:ask`, `lm:{s}:answered:{agent}` | open items (U6) |
| `lm:{s}:outbox:mark` | last `seq` shipped to Postgres |
| `lm:{s}:meta` | HASH: registry projection read by the data plane (`schema_version`, `plan`, `retention_hot_days`, quota numbers, `status`) |
| `lm:{s}:{ns}:{id}:who\|now\|recap\|follows\|shifts\|sessions`, `lm:{s}:{ns}:list`, `lm:{s}:session:{sid}`, `lm:{s}:mirror:retry` | as v0, re-prefixed |
| `lm:oauth:*` | outside every space (S3 moves it to the deploy Redis) |

**No global SCAN.** `scanKeys` in `view.mjs` (log, settings) and the `list()` × `readLog(500)` loops in
`keywordRecall` are removed from request paths. A test greps `src/core`, `src/http` and `api/` for
`"SCAN"`/`"KEYS"` and fails outside `scripts/`.

### 4.2 Space registry

Postgres is the source of truth (control plane). `lm:{s}:meta` is a projection that the control plane writes
on change. Self-hosted stdio with no account has no registry, so the server uses defaults and writes `meta`
itself on the first write.

```jsonc
{
  "space": "madez", "display_name": "Madez fleet", "owner_account": "acct_…",
  "plan": "free" | "team" | "agency",
  "backend": { "kind": "hosted" | "byo", "region": "eu-central", "redis_ref": "sec_…" },  // secret id, never creds
  "archive": { "enabled": true, "target": "logmem-pg" | "none" },
  "retention": { "hot_days": 30, "history_days": 365 },
  "quotas": { "entries_per_day": 5000, "max_entry_bytes": 16384, "agents": 10, "storage_mb": 256 },
  "schema_version": 1, "contract": "1.0",
  "compat": { "acmi": false, "mirror": false },
  "status": "active" | "suspended" | "migrating" | "deleting",
  "created_at": "...", "updated_at": "..."
}
```

### 4.3 Postgres for history, search and export

```sql
create table entries (
  space text not null, id char(26) not null, seq bigint not null, ts timestamptz not null,
  kind text not null, by_ref text not null, trail text, origin text, logs text[] not null,
  body jsonb not null, redacted_at timestamptz,
  tsv tsvector generated always as
    (to_tsvector('simple', coalesce(body->>'summary','') || ' ' || coalesce((body->'payload')::text,''))) stored,
  primary key (space, id));
create index on entries (space, seq);
create index on entries using gin (logs);
create index on entries using gin (tsv);
alter table entries enable row level security;   -- policy: space = current_setting('app.space')
```

**Why Postgres.** Upstash Redis has no RediSearch, so FTS in Redis would mean running our own Redis Stack.
History beyond the hot window costs too much in RAM. Export, delete-space (P3) and analytics are SQL problems.
`pgvector` gives P5 a place to land.
**Rejected: everything in Redis.** No FTS on Upstash, RAM cost grows with history, and retention would have to
choose between losing data and paying for memory. **Rejected: Postgres as the primary store.** It adds a
second network hop to every write from serverless, breaks the "bring your own Redis" story, and the ACMI
compat and mirror are Redis-shaped. **Rejected: object storage alone.** It handles export, but not search.

### 4.4 Outbox

Every append and redaction gets a `seq`. A worker (Vercel cron, every minute in v1.1) runs per active space:
`ZRANGE activity (mark +inf BYSCORE LIMIT 0 500` + `HMGET` → `INSERT … ON CONFLICT (space,id) DO UPDATE`, then
it drains `redactions` the same way and `SET outbox:mark`. Upserts are idempotent, so a crash just replays.
The set of active spaces comes from the registry, not from SCAN.

### 4.5 Hosted and BYO side by side

Both run the same store code. The registry `backend.kind` only decides where the runner's credentials come
from and whether the outbox runs.

| | Hosted | BYO |
|---|---|---|
| Hot store | LogMem Redis: shared for free/team, dedicated instance for agency | customer's Redis (creds sealed per S3) |
| Archive/search | Postgres, always | off by default (data stays with them); opt in to LogMem Postgres; BYO-Postgres DSN is v1.2+ |
| Recall without archive | | keyword over the hot window only |
| Writes | `atomic` required | `atomic` or `sequenced` |

### 4.6 Tenant isolation, plainly

- **Hosted shared tier:** every space sits in the same Redis behind **one credential that the LogMem server
  holds**. Isolation is enforced only by the server: the space is bound by the authenticated connection, never
  taken from a parameter, and key segments are validated. A bug in that code path is a cross-tenant read.
  Mitigations: one key builder (`lmKey`) as the only way to name a key, a cross-space fuzz test, Postgres RLS
  as a second check on history, and Redis ACL users scoped `~lm:{s}:*` where the provider supports them
  (self-run Redis 6+, not Upstash REST today).
- **Dedicated tier (agency):** a separate Redis instance per customer, so separate credentials. That's real
  isolation at the storage layer.
- **BYO:** anyone holding the customer's Redis creds can read every space in that Redis. Spaces inside one BYO
  Redis are a namespace, not a security boundary.
- **The fleet today:** one bridge token reaches all of `acmi:*` and `lm:*` (S1). There's no isolation at all
  until S1 lands.

---

## 5. U5, U6, U8

### 5.1 Auto-Recap correctness (U5)

Today `recapShift` reads only the **agent's own log** since `started_at`, then filters by `shift`. Entries the
agent wrote to jobs and channels are missed, and so are handoffs it sent (those land on the receiver's log and
the job). Two concurrent stateless calls after an idle gap can both write the idle Recap.

Fixes:

1. Every append adds its id to `lm:{s}:shift:{entry.shift}` (prelude). The Recap is
   `ZRANGE shift:{id} 0 -1` (capped at 500) + `HMGET`, so it counts every entry the shift wrote, wherever it
   landed, once each.
2. The session record gains `ver`. All transitions (auto Start, idle Recap, switch Recap, manual Recap) go
   through the `shift` script's compare-and-set, so exactly one caller writes the Recap and the loser adopts
   the winner's record.
3. The Recap's own entry and the `started` entry are excluded from its counts (filter by kind).

### 5.2 Open handoffs and asks (U6)

- `handoff` → `ZADD open:handoff:{to}`. `accept` → `ZREM`.
- `ask` → `ZADD open:ask`. `decide` → `ZREM` + `answered:{asker}`.
- Brief, `logmem_pending`, the overview "waiting" count and the dogfood "unanswered for more than 24 h" check
  read these sets (`ZRANGEBYSCORE open:* -inf now-24h`), not the last 200–500 log entries.
- Open items are **pinned**: retention never trims an entry that is still in an open set.
- Migration fills the sets from v0 by the current rule: a handoff with no `accepted` whose origin is its
  trail, and an approval with no `decided`.

### 5.3 Bounded reads (U8)

| Read | v0 | v1 |
|---|---|---|
| any log | `ZRANGEBYSCORE -inf +inf` then slice in JS | `page`: `ZRANGE … BYSCORE REV LIMIT` + `HMGET` |
| overview/log views | SCAN every `:log`, 100 each, dedupe by signature | `ZRANGE activity +inf -inf BYSCORE REV LIMIT 0 200` + `HMGET` |
| channels list | `list` + 1 read per channel | `lm:{s}:logs` filtered to `channel:` |
| settings key count | SCAN | `meta` counters + `HLEN entries` |
| compat legacy log | `ZRANGE 0 -1` (whole key) | **bounded to the ms score window** `[since, now]`, `REV LIMIT`. Legacy entries scored in ns/µs/s fall outside it and become visible through the migrated `lm` copy, which has corrected scores. That's 74 entries per the dry run, an accepted trade |
| compat dedupe | `ts|trail|summary` signature | skip legacy members with `mirrored_from: "lm"` (twins carry `lm_id`) |
| recall | every log × 500 entries | v1.0: keyword over the last 2,000 `activity` ids (HMGET in batches of 200). v1.1: Postgres FTS (`mode: "fts"`). Embeddings come after (P5) |

---

## 6. D5: retention and ACMI sunset

### 6.1 Hot window

Default `hot_days`: **30** on free, **90** on team and agency. BYO defaults to **off** (never trim) unless set,
because it's their memory.

The daily trimmer (v1.1) runs only when `archive.enabled` and does this per space:

1. Pick candidate ids: `ZRANGEBYSCORE activity -inf <mark> LIMIT 0 5000`, so only already-archived seqs.
2. Keep ids with `ts` older than the window that aren't in any `open:*` set.
3. For each id, `ZREM` from every log in its `logs` and from `activity`, then `HDEL entries`.

Who, Now, Recap, follows and rosters are never trimmed. Reads that page past the hot window return
`next_cursor` plus `details.archived: true`, and v1.1 continues the page from Postgres transparently.

### 6.2 Archive

- History: Postgres `entries`, kept `history_days` (365 free, unlimited paid).
- Export/backup: nightly gzipped JSONL per space per day to object storage
  (`archive/{space}/{yyyy}/{mm}/{dd}.jsonl.gz`). `/api/export` streams from Postgres (P3).
- A redaction marks that day's file dirty, and the worker rewrites it within 24 h. This is the stated GDPR
  erasure SLA, together with immediate removal from Redis and Postgres.

### 6.3 ACMI sunset

| Step | Target date | Conditions (all must hold) |
|---|---|---|
| Mirror off (`LOGMEM_MIRROR_ACMI=0`) | **2026-12-01** | dogfood gate GO; ACMI `--apply` + `--verify` clean; every VM writer (opencode, codex, ops-center, bentley, grok) reads LogMem directly or through compat |
| Compat reads off (`LOGMEM_ACMI_COMPAT` removed, `acmi_*` tools kept only as v1.x aliases writing `lm`) | **not before 2027-01-15** | zero native `acmi:madez:*` writes (entries without `mirrored_from`) for **14 consecutive days**, measured by the daily check; one delta copy run since the last native write |
| Compat code deleted | **by 2027-03-31** | the above, plus Mikey GO. If the conditions aren't met by then, compat stays but remains bounded (§5.3), and the date moves only by a written decision |

Legacy `acmi:*` cleanup stays a separate HITL task (PLAN.md step 6).

---

## 7. Phased plan

Target v1.0 is after the dogfood gate (Oct 21). Nothing changes key layout during the 7-day pass window.

### v1.0

| Phase | Ships | Tests | Migration / dry run |
|---|---|---|---|
| A. Runner | `script()`, `pipeline()`, probe, native passthrough, JS script twins | unit: EVALSHA → NOSCRIPT → EVAL; 403 → `sequenced`; `REQUIRE_SCRIPTS` refuses. **Differential**: random op sequences give identical key state under Lua (local Redis :6399) and the JS twin | `bridge-probe --scripts` extended to EVAL/EVALSHA/`/pipeline` on `lm:probe:*` (HITL run on Polar) |
| B. Entry v1 and store | ULID, `seq`, `entries`, `{s}` keys, `activity`, `logs`, `idem`, reserved ns | ordering with same-ms ties; transport-retry exactly-once; idempotency conflict; 16 KB cap; cross-space fuzz | `migrate-v0-v1 --dry-run` on `lm:madez:*` (read-only allowlist): counts, groups, ids, report hash |
| C. Workflows | `handoff/accept/ask/decide/shift/redact`, open indexes, shift index, Brief/Recap rewired | race tests: 2 accepts → 1 wins; 2 decides → `already_decided`; 2 idle touches → 1 Recap; Recap counts job and channel entries; `waiting_on` cleared only for its ask | dry run reports the open sets that would be built |
| D. Contract 1.0 and bounded reads | §3 tools, errors, version, `page`, view.mjs without SCAN, bounded compat | `spec:check`; cursor round trip with no dupes or gaps across ties; no-SCAN grep test; ACMI conformance 30/30 + 35/35; Field Notes day end to end | n/a |
| E. Cutover | `--apply` (HITL) → `--verify` → switch `madez` agents | verify: `ZCARD` parity, no `seq` gaps, all ms | v0 keys kept 30 d |

### v1.1

| Phase | Ships | Tests | Dry run |
|---|---|---|---|
| F. Archive and search | Postgres schema, outbox worker, FTS recall, `/api/export`, redaction propagation | replay idempotency; redaction reaches Redis, PG and JSONL; RLS denies cross-space | outbox `--dry-run` prints the rows it would upsert |
| G. Retention and registry | trimmer, registry tables + `meta` projection, quotas, hosted provisioning | open items never trimmed; reads past the window continue from PG | trimmer `--dry-run` lists ids per space |
| H. Sunset and hardening | mirror off, compat removal path, ask enforcement (O3), signed session ids (O4), `repair` | daily check measures native ACMI writes | 14-day zero-native-writes report |

## 8. Risks

1. **The fleet bridge blocks EVAL.** `madez` then runs `sequenced`. Races are settled by `seq` but not
   prevented. Mitigation: ask for EVAL/EVALSHA/SCRIPT in the allowlist (Q1), or move `madez` to a
   script-capable Redis.
2. **Upstash Lua limits** (script time, size, request size on large `HMGET`). Mitigation: pages ≤ 200,
   `page` ≤ 16 logs, trimmer batches of 5,000.
3. **The `entries` HASH grows with history** until v1.1 trimming. 36k entries is ~20 MB, so this is fine for
   the fleet but has to land before hosted free signups.
4. **Clock skew between serverless instances** reorders entries within a few ms. Display is `(ts, id)`;
   `seq` is the truth for sync. Accepted.
5. **Two migrations in flight** (v0 `lm` → v1, `acmi` → v1) plus compat merge. Mitigation: v1 cutover only
   after the gate; the ACMI copy targets v1 directly; both have `--verify`.
6. **Shared-credential hosting** puts a single code path between tenants (§4.6). Mitigation: fuzz + RLS +
   ACLs where possible; a dedicated tier for customers who need real isolation.
7. **The human-only decide** depends on admin auth until U7. Until then the single admin password is the only
   approver identity, and that's weak (S2 is only as strong as that password).

## 9. Questions for the owner

1. **Bridge scripts:** will the fleet bridge allow `EVAL`/`EVALSHA`/`SCRIPT LOAD` (and a pipeline endpoint)?
   Or is `sequenced` mode acceptable for `madez` until the bridge is replaced?
2. **Postgres and plans:** which Postgres provider for the hosted control plane and archive, and are the
   defaults right (hot 30/90 days, history 365 days free, BYO archive off)?
3. **Sunset dates:** are mirror-off 2026-12-01 and compat removal between 2027-01-15 and 2027-03-31 acceptable,
   and who drives the VM-agent cutover that the 14-day zero-native-writes condition depends on?
