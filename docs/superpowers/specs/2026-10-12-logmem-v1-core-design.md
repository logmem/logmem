# LogMem v1 core: design (Tier 1)

Date: 2026-10-12 (rev 3: per-item decisions, trade-offs and migration paths in §9; storage-unit ruling in §1.7;
§10 Decisions for Mikey) · Status: **DRAFT for owner review**
· Covers GAPS.md D1–D5, U5, U6, U8 · Once accepted, supersedes "Entry shape" and "Key layout" in `docs/KEYS.md`
and §3–§4 of `docs/spec/tools.md`. Docs only: nothing here has been built, deployed or run against any Redis.

## 0. Decisions at a glance

| # | Decision |
|---|---|
| D1 | Every entry gets a server-minted **ULID `id`**, schema version **`v: 1`** and a **space-wide `seq`**. Bodies are stored once, in **day buckets** `lm:{s}:e:{yyyymmdd}` (HASH id → JSON). Every log is a ZSET with **member = id, score = seq**. Content dedupe and `_o` go away. Retries dedupe on `id`; clients dedupe with `idempotency_key`. Entries are immutable; the only in-place change is a human **redaction** that leaves a tombstone |
| D2 | Six workflow scripts (`append`, `handoff`, `accept`, `ask`, `decide`, `shift`), an admin `redact` script and a read-only `page_ids` script. **Every script runs all checks before its first write** and returns documented status codes. Where scripts are refused, **sequenced mode** uses single-command **claim keys** (`SET … NX`) written before any entry, so exactly one caller wins on any bridge. Hosted requires atomic |
| D3 | Contract **1.0**: seq cursors on every list read (forward polling included), `idempotency_key` + `id`/`seq` on entry writes, `logmem_accept`, `logmem_pending`, human-only `logmem_decide` with `verdict`, `to` checked against the roster, coded errors, contract version in `initialize` |
| D4 | Keys are `lm:{space}:…` (hash tag): one space lives in one slot, which caps a space at one shard. No SCAN or whole-bucket reads on any request path. v1.0 ships the **outbox hooks** (seq, activity, marks, redaction log). The first archive (v1.1) is **JSONL in object storage** for export and delete; Postgres history and search follow in v1.1. Isolation is enforced by the LogMem server, not by Redis |
| D5 | Hot window 30 days (free) or 90 days (team, agency). Trimming = `UNLINK` of old day buckets (v1.1). Mirror off targeted for **2026-12-01**. Compat reads are removed **between 2027-01-15 and 2027-03-31**, and only when the §6 conditions hold |

Prerequisites outside this design: **S2** (human-only `decided`) ships earlier as a v0.x hotfix in a separate
PR (T0-b). **O1** (a required CI gate) must land before any v1 phase merges.

---

## 1. D1: entry identity and storage

### 1.1 Entry shape (v1)

```jsonc
{
  "seq": 4182,                          // space-wide order, spliced in by the script
  "v": 1,
  "id": "01JA7Q8K3M5V2C9RZB6T4XWDHN",   // ULID; first 10 chars = ts; also names the day bucket
  "ts": 1791731538741,                  // ms, equal to the ULID time
  "kind": "handoff",
  "by": "agent:quill", "via": "codex", "byline": "quill (via codex)",
  "shift": "quillShift-1791731500000",
  "trail": "handoffIssue14-1791731538741",
  "origin": "assignedIssue14-1791731400000",
  "logs": ["job:issue-14", "agent:atlas"],
  "summary": "...", "payload": {},      // summary ≤ 500 chars, entry ≤ 16 KB (S7)
  "to": "agent:atlas"
}
```

- `id`: a ULID minted in Node, monotonic within a process (about 30 lines, no dependency). Only the
  import/migration path may backdate, and it mints the ULID from the historic `ts`. Client-supplied `ts` is
  dropped from the contract.
- `seq`: one counter per space, `lm:{s}:seq`. A fanned-out entry has **one** seq. Seq is the order of every
  log and of `activity`, and it is the cursor (§1.3). In atomic mode, scripts call `INCR` only after their
  checks pass, so rejected calls don't consume seqs. **A seq gap does not mean a lost write.** Gaps are normal
  in sequenced mode (a crash between `INCR` and the body write) and must never be treated as data loss.
- `v`: readers treat a missing `v` as 0 (v0 `lm`, or legacy ACMI) and upgrade it on read.

**Rejected: a per-log sequence.** A fanned-out entry would have a different number in every log. Per-log
counts are `ZCARD`. **Rejected: Redis Streams.** IDs can't be backdated, entries can't be replaced in place
for redaction, and ACMI timelines are ZSETs. **Rejected: client ids.** They allow collisions and forged order;
clients get `idempotency_key` instead.

### 1.2 Storage layout

| Key | Type | Content |
|---|---|---|
| `lm:{s}:e:{yyyymmdd}` | HASH | `id` → entry JSON. The bucket is the UTC day of the ULID time |
| `lm:{s}:seq` | STRING | entry counter |
| `lm:{s}:{ns}:{id}:log` | ZSET | member `id`, score `seq` |
| `lm:{s}:activity` | ZSET | member `id`, score `seq` (every entry in the space) |
| `lm:{s}:days` | ZSET | member `yyyymmdd`, score = first seq of that day (used for retention) |
| `lm:{s}:idem:{h}` | STRING | `"<id>|<req_hash>"`, `EX 86400` |

Bodies are stored once and bucketed by day. Readers find the bucket from the id alone, and retention drops
whole buckets with `UNLINK` instead of `HDEL`ing ids one at a time. `HGETALL`/`HLEN`/`HSCAN` on `:e:` keys are
banned from request paths (§4.1 grep test). Totals live in `lm:{s}:meta` (`entries_total`, via `HINCRBY` in
the scripts).

**Rejected: member = JSON (v0).** Redaction would touch every copy, dedupe is a read-then-write race, and
pages are large. **Rejected: one unbucketed `entries` HASH.** It grows without bound and can only be trimmed id
by id. **Rejected: one STRING key per entry.** That's millions of keys and pushes operators back to SCAN.

### 1.3 Cursors

All cursors are seq-based: `base64url(JSON {"c":1,"seq":<n>,"d":"rev"|"fwd"})`, opaque and exclusive.
Scores are integer seqs, so there are no ties and a page is a single exclusive range:

- Reverse browsing (newest first): `ZRANGE key (<seq> -inf BYSCORE REV LIMIT 0 <n>`.
- Forward, tail and poll (oldest first, "what's new since my cursor"):
  `ZRANGE key (<seq> +inf BYSCORE LIMIT 0 <n>`.
- `feed` merges logs by seq, which is a total order across the space, so one cursor covers every log.
- `since` windows (`24h`) filter on `ts` while paging in reverse and stop at the first entry older than the
  window. History is seq-ordered in `ts` order at migration (§1.6). After that, seq order and ts order agree to
  within clock skew.

**Why not (ts, id).** A poller holding a ts cursor misses entries that commit later with a slightly earlier
`ts` (clock skew between serverless instances). Seq is assigned at commit, so forward cursors never skip an
entry that was atomically committed. Using seq for every direction also removes tie handling, so (ts, id) is
not used anywhere.

Settle rule for forward readers in **sequenced** mode only: a gap at `seq = m+1` is held for up to **60 s**
(measured from the `ts` of the first entry after the gap), then skipped. Forward results carry
`next_cursor` at the last contiguous or settled seq. Atomic mode has no in-flight gaps, so the rule never
fires there.

### 1.4 Dedupe and idempotency

- **Transport retries**: Node mints `id` before the call, so a retry with the same `id` finds
  `HEXISTS e:{day} id` and gets status `0 replay`, and nothing is written twice.
- **Client retries**: optional `idempotency_key` (≤ 128 chars) on **tools that write entries**.
  `h = sha256(tool ‖ agent ‖ key)[:32]` and `req_hash = sha256(canonical args minus key)`. Same key and same
  args replay the original (`deduped: true`). Same key with different args returns `idempotency_conflict`.
  The idem value holds only the `id`, and the caller reads the body afterwards, because a script can only
  touch the bucket keys it was given.
- `status`, `bio` and `follow` write no entry. They return no `id`/`seq` and take no `idempotency_key`; they
  are idempotent overwrites already.
- Content dedupe is removed.

### 1.5 Edits and redaction

- Entries are **immutable**. A correction is a new entry (`kind: "fix"`, `amends: "<id>"`). There's no edit
  tool.
- Derived state moves out of entries: approval `status` becomes membership of `open:ask` (§5.2).
- **Redaction (GDPR erasure of one entry)** is human-only, through the admin endpoint
  `POST /api/spaces/{s}/entries/{id}/redact`, which runs the `redact` script. The body is replaced in its
  bucket by a tombstone that keeps the chain:
  `{"seq","v","id","ts","kind","by","trail","origin","logs","redacted":{"at","by","reason_code"}}`.
  `summary`, `payload`, `action` and other kind-specific text are dropped.
  - The redaction is recorded in `lm:{s}:redactions` (score = its own counter `lm:{s}:rseq`), which the archive
    drains through a separate mark (§4.4).
  - The script writes an audit entry of the **dedicated kind `redacted`**, with `redacts: <id>`, to
    `lm:{s}:space:audit:log`. It is not a `fix` and not an amendment, and it never contains the erased text.
  - The mirror replaces the ACMI twin, found by `ZRANGEBYSCORE acmi…:timeline ts ts` + `lm_id`.
- `logmem_remove` refuses `:log` and `:e:` keys in v1 (`invalid_argument`).

### 1.6 Migration from v0 (member-is-JSON + `_o`)

v1 keys (`lm:{madez}:…`) don't overlap v0 keys (`lm:madez:…`). `scripts/migrate-v0-v1.mjs` has three modes:
`--dry-run` (read-only allowlist), `--apply` (HITL, needs the dry-run report hash) and `--verify`.

1. **Freeze.** Announce on `thread:agent-coordination`, stop the dogfood agents writing to `lm:madez` (three
   Mac agents, a window of about 15 min) and record `t_freeze`. If a freeze isn't possible, run a **delta
   pass** after the copy: re-read members with `ts ≥ t_copy_start`, copy whatever is new, and repeat until a
   pass copies nothing.
2. Read every v0 log from the `lm:madez:{ns}:list` sets (no SCAN). Parse, strip `_o`, sort by `(ts, _o)`.
3. **Group fan-out copies only when byte-equal.** Group v0 members across logs when their `stableJson`,
   minus the log-specific fields (`_o`), is byte-identical; that group becomes one entry with `logs: [...]`.
   Members that look alike but differ in any byte stay separate entries and are listed in the report under
   `ungrouped_lookalikes`.
4. Mint ULIDs from `ts` (monotonic in `_o` order). Assign seq in global `(ts, _o)` order, across v0 **and** the
   ACMI copy if both run in the same window. Write buckets, logs, activity, days, open indexes (§5.2) and shift
   indexes (§5.1). Who/now/recap/follows/shifts/sessions are copied as-is.
5. **Cross-source dedupe.** In the ACMI copy, skip legacy members with `mirrored_from: "lm"` whose original is
   in v0 `lm`. v0 twins have no `lm_id`, so the match is `(ts, trail, summary, by)` and each skip is reported.
6. **`--verify`, field by field.** For every v0 member, the v1 body minus `seq, v, id, logs` must equal the v0
   member minus `_o` on every field, compared with `stableJson` per field. Any diff is reported with the field
   name. It also checks that every v0 log has exactly the expected set of ids, that every id resolves to a
   bucket, that `ZCARD`s agree, and that `entries_total` matches.
7. **Rollback.** v0 keys stay untouched for 30 days. Rolling back to the v0 server **loses every write made to
   v1 after cutover** unless `migrate-v1-v0 --since <cutover seq>` is run. That script is a reverse copy: v1
   bodies become v0 members with fresh `_o` ordinals. It exists for the 7-day rollback window only. During
   dogfood the ACMI mirror also still holds those writes.

The ACMI `--apply` (PLAN.md step 2) targets the v1 shape with the same rules. Old history imported **after**
cutover would get new seqs and sort as new, so v1 does not support late history imports. Any key missed at
cutover is reported and needs a deliberate decision.

### 1.7 Timestamp unit (fleet ruling)

- **Milliseconds are the LogMem storage unit.** Every `ts` LogMem writes is epoch ms, and so is the ULID time
  that names the day bucket. This is already true of v0 writes (`store.mjs` `append`; `KEYS.md` "Writes: ms").
- In v1 the log scores are seqs, not timestamps, so the unit no longer affects ordering. It still matters for
  `since` windows, day buckets, retention, and the JSONL/Postgres archive.
- Client-supplied `ts` is dropped from the contract (§3.4), so agents can't write ns or s into v1 at all. Only
  the import path backdates, and it normalizes first.
- **The ACMI compat layer normalizes ns, µs and s to ms on read.** It uses the existing `normTs`
  (`src/core/store.mjs`, with these thresholds: > 1e17 is ns, > 1e14 is µs, 1e9–1e11 is s). Legacy keys are
  never rewritten in place.
- The ACMI `--apply` copy (§1.6) writes ms only. The 74 legacy entries that are scored in other units
  (`docs/migration/PLAN.md`: 69 ns, 3 µs, 2 s) are normalized on the way in.
- **Open:** a fleet note asserts ns as the unit. It conflicts with this ruling and has not been reconciled.
  It is flagged as Mikey M2 (§10); this design does not choose between them. If ns were adopted, only §1.7 and
  the archive column types would change. Seq ordering, cursors and the scripts are unit-independent.

---

## 2. D2: atomic write path

### 2.1 Script rules

1. **Checks first.** A Redis script is not all-or-nothing: an error after a write leaves that write applied.
   So every script runs every check first (`TYPE` of each key it will write is the expected type or `none`,
   then `SISMEMBER`/`ZSCORE`/`HEXISTS`/`EXISTS` and body checks) before its first write. The write phase uses
   only commands that can't fail once the types are known.
2. **Declared keys only.** Bucket keys are computed in JS from the ids and passed in `KEYS`. No script builds
   a key name.
3. **No cjson re-encode.** `seq` is spliced into the body string (`'{"seq":'..n..','..body:sub(2)`), because
   cjson turns `[]` into `{}` and reformats numbers. `cjson.decode` is used only to *read* bodies in checks.
4. **No `ZREMRANGEBYRANK`.** The fleet bridge blocks it. Caps use `ZPOPMIN key (ZCARD − cap)` where that is
   allowed; otherwise they are read-side only (`REV LIMIT cap`). Capped sets are small and also covered by
   retention.
5. **Claims in both modes.** Scripts write the same claim keys as sequenced mode (§2.4), so a backend that
   changes mode keeps one source of truth.

The shared prelude is two functions over **named** tables, not raw KEYS/ARGV:

```lua
-- k = {bucket, seq, activity, days, logs_index, meta, idem|false, shift_idx|false, logs={...}}
-- a = {id, ts, day, body, req_hash, idem_ttl, shift_ttl, refs={...}}
-- is_type(key, t): TYPE(key) is t or 'none'
local function core_check(k, a)
  if redis.call('HEXISTS', k.bucket, a.id) == 1 then return 0 end          -- replay
  if k.idem then
    local prev = redis.call('GET', k.idem)
    if prev then
      local pid, ph = string.match(prev, '([^|]+)|(.*)')
      if ph ~= a.req_hash then return -1 end                               -- idempotency_conflict
      return 0, pid                                                        -- replay
    end
  end
  for _, key in ipairs(k.logs) do if not is_type(key, 'zset') then return -2 end end
  if not is_type(k.bucket, 'hash') then return -2 end
  return nil                                                               -- clear to write
end
local function core_write(k, a)
  local seq = redis.call('INCR', k.seq)
  redis.call('HSET', k.bucket, a.id, '{"seq":' .. seq .. ',' .. string.sub(a.body, 2))
  redis.call('ZADD', k.activity, seq, a.id)
  redis.call('ZADD', k.days, 'NX', seq, a.day)
  redis.call('HINCRBY', k.meta, 'entries_total', 1)
  for i, lk in ipairs(k.logs) do
    redis.call('ZADD', lk, seq, a.id); redis.call('ZADD', k.logs_index, a.ts, a.refs[i]) end
  if k.shift_idx then redis.call('ZADD', k.shift_idx, seq, a.id); redis.call('EXPIRE', k.shift_idx, a.shift_ttl) end
  if k.idem then redis.call('SET', k.idem, a.id .. '|' .. a.req_hash, 'EX', a.idem_ttl) end
  return seq
end
```

### 2.2 Scripts, KEYS/ARGV and status codes

Common KEYS **C** = `[bucket, seq, activity, days, logs_index, meta, idem (or dummy lm:{s}:idem:-), shift_idx]`.
Common ARGV **A** = `[id, ts, day, body, req_hash ('' = none), idem_ttl, shift_ttl]`. Scripts that use C/A
pass `k` and `a` built from those positions, plus their own `logs`/`refs`.

| Script | Extra KEYS | Extra ARGV | Checks (all before any write) | Writes |
|---|---|---|---|---|
| `append` (note, update, stage, assign) | `now_hash` or dummy, `log…` | `now_pairs_json`, `ref…` | core | core; `HSET now` |
| `handoff` | `agent_list`, `open:handoff:{to}`, `follows:{to}`, `job_now` or dummy, `log…` | `to`, `follows_json`, `owner_pairs_json`, `ref…` | `SISMEMBER agent_list to` (else −10); core | core; `ZADD open`; `HSET follows`; `HSET job now` |
| `accept` | `handoff_bucket`, `open:handoff:{me}`, `claim:accept:{hid}`, `log…` | `handoff_id`, `me`, `claim_ttl`, `ref…` | claim exists → −23 (returns the winner id); handoff body missing → −20; `kind ≠ handoff` → −21; body `to ≠ me` → −22; not in open set → −24; core | `SET claim NX`; core; `ZREM open` |
| `ask` | `open:ask`, `asker_now`, `log…` | `waiting_on_json`, `ref…` | core | core; `ZADD open:ask`; `HSET waiting_on` |
| `decide` | `ask_bucket`, `open:ask`, `asker_now`, `answered:{asker}`, `claim:decide:{aid}`, `log…` | `ask_id`, `verdict`, `asker`, `claim_ttl`, `ref…` | claim exists → −33; ask body missing → −30; `kind ≠ approval` → −31; body `by ≠ asker` → −32; `verdict ∉ {approve,reject}` → −34; not in `open:ask` → −33; core | `SET claim NX`; core; `ZREM open:ask`; `HDEL waiting_on` only if it names `ask_id`; `ZADD answered`; `ZPOPMIN` past 50 |
| `shift` | own layout, below | own layout, below | `GET session` `.ver ≠ expected` or `EXISTS session:v{n+1}` → −40 (returns the current record); core for each entry | `SET session:v{n+1} NX`; recap core; start core; `SET recap`; `ZADD shifts`; `SET session` (ver n+1) |
| `redact` (admin) | own layout, below | own layout, below | body missing → −50; already a tombstone → −51; core for the audit entry | `HSET` tombstone; `INCR rseq`; `ZADD redactions`; audit core |
| `page_ids` (`#!lua flags=no-writes`) | `log…` (≤ 16) | `dir`, `cursor_seq`, `limit` | none | none: returns merged `[id, seq]…` and `next_cursor` |

**`shift` layout.** KEYS: 1 `session`, 2 `session:v{n+1}`, 3 `seq`, 4 `activity`, 5 `days`, 6 `logs_index`,
7 `meta`, 8 `recap_bucket`, 9 `start_bucket`, 10 `old_shift_idx`, 11 `new_shift_idx`, 12 `old_agent_log`,
13 `new_agent_log`, 14 `old_recap`, 15 `new_shifts`. ARGV: 1 `expected_ver`, 2 `new_rec`, 3 `session_ttl`,
4 `recap_id`, 5 `recap_ts`, 6 `recap_day`, 7 `recap_body` ('' = none), 8 `recap_doc`, 9 `start_id`,
10 `start_ts`, 11 `start_day`, 12 `start_body` ('' = none), 13 `shift_member`, 14 `shift_ttl`, 15 `old_ref`,
16 `new_ref`.
Recap entry: `k = {bucket=K8, seq=K3, activity=K4, days=K5, logs_index=K6, meta=K7, idem=false, shift_idx=K10, logs={K12}}`,
`a = {id=A4, ts=A5, day=A6, body=A7, shift_ttl=A14, refs={A15}}`.
Start entry: same, but `bucket=K9, shift_idx=K11, logs={K13}`, `a = {id=A9, ts=A10, day=A11, body=A12, refs={A16}}`.

**`redact` layout.** KEYS: 1 `target_bucket`, 2 `rseq`, 3 `redactions`, 4 `audit_bucket`, 5 `seq`,
6 `activity`, 7 `days`, 8 `logs_index`, 9 `meta`, 10 `audit_log`. ARGV: 1 `id`, 2 `tombstone_json`,
3 `audit_id`, 4 `audit_ts`, 5 `audit_day`, 6 `audit_body`, 7 `audit_ref` (`space:audit`).
Audit entry: `k = {bucket=K4, seq=K5, activity=K6, days=K7, logs_index=K8, meta=K9, idem=false, shift_idx=false, logs={K10}}`.

**Status codes** (the first element of every reply):

| Code | Meaning | Tool error |
|---|---|---|
| 1 | written; reply `{1, id, seq}` | |
| 0 | replay (same id, or idempotency hit); reply `{0, id}` | (ok, `deduped: true`) |
| −1 | idempotency key reused with different args | `idempotency_conflict` |
| −2 | a key has an unexpected type; nothing written | `internal` (alert) |
| −10 | `to` not on the roster | `unknown_agent` |
| −20 / −21 / −22 | handoff not found / not a handoff / not addressed to you | `not_found` / `invalid_argument` / `forbidden` |
| −23 | already accepted (reply carries the accepting id) | `already_accepted` |
| −24 | addressed to you but no longer open (reassigned, or trimmed) | `not_open` |
| −30 / −31 / −32 | ask not found / not an approval / asker mismatch | `not_found` / `invalid_argument` / `invalid_argument` |
| −33 | already decided | `already_decided` |
| −34 | bad verdict | `invalid_argument` |
| −40 | shift version conflict (reply carries the current record; the caller adopts it) | (internal, not surfaced) |
| −50 / −51 | redaction target missing / already redacted | `not_found` / `conflict` |

### 2.3 Reads

`page_ids` merges ids by seq across up to 16 logs in one call. Bodies then come from **one pipelined `HMGET`
per day bucket**; ids are grouped by the bucket derived from their ULID. Without scripts, the first step is a
pipelined `ZRANGE … LIMIT` per log, merged in JS. Brief, View and Open batch their
who/now/recap/follows/shifts reads into one `pipeline()`. An id whose bucket has been trimmed is skipped, and
the reader removes it from that log with `ZREM` (bounded to 50 per read).

### 2.4 Runner and modes

```js
runner.script(name, keys, args)  // EVALSHA → NOSCRIPT → EVAL (REST) / SCRIPT LOAD + EVALSHA (TCP)
runner.pipeline(cmds)            // Upstash REST /pipeline; node-redis execAsPipeline(); else Promise.all
runner.caps                      // { writes: "atomic"|"sequenced"|"refused", pipeline, redis7, zpopmin, probed_at }
```

- **node-redis**: `redis-native.mjs` gets a `default:` passthrough to `client.sendCommand([...])`.
- **Memory** (tests, degraded): runs the sequenced implementation, which CI tests against real Lua.
- **Probe** (stdio at boot; HTTP cached 10 min per warm instance):
  1. `EVALSHA sha("return 1") 0`: NOSCRIPT or 1 means scripts are allowed; 403 or "not allowed" means they
     aren't.
  2. `EVAL "#!lua flags=no-writes\nreturn 1" 0` tells whether Redis is 7+. `page_ids` gets the shebang only on
     7+, because Redis 6 rejects the line.
  3. `ZRANGE k 0 0 BYSCORE REV LIMIT 0 1` checks for 6.2+. On older Redis, the runner falls back to
     `ZREVRANGEBYSCORE`.
  4. `ZPOPMIN lm:{s}:probe 0` and `POST /pipeline [["PING"]]`.

| Mode | When | Behaviour |
|---|---|---|
| `atomic` | scripts allowed | §2.2. **Required for hosted** |
| `sequenced` | scripts refused, `LOGMEM_REQUIRE_SCRIPTS` unset. **BYO and `madez` only** | single-command claim keys, below |
| `refused` | scripts refused and `LOGMEM_REQUIRE_SCRIPTS=1` (the hosted default) | writes return `backend_refused` |

**Sequenced mode.** The step that decides the winner is a single `SET … NX`, which every bridge executes
atomically. It always comes **before** anything entry-related. The claim value carries the full intended write
(entry body and side effects), so the winner's work can be completed later by anyone.

| Operation | Claim (first command) | Loser gets |
|---|---|---|
| any write with `idempotency_key` | `SET idem:{h} "<id>|<req_hash>" NX EX 86400` | replay or `idempotency_conflict` |
| accept | `SET claim:accept:{handoff_id} <write JSON> NX EX <hot window + 7 d>` | `already_accepted` + the winner id |
| decide | `SET claim:decide:{ask_id} <write JSON> NX EX <hot window + 7 d>` | `already_decided` |
| shift transition | `SET session:{sid}:v{ver+1} <write JSON> NX EX <session ttl>` | re-reads, then adopts |
| plain append | none needed: only this caller holds the fresh `id` (`HSETNX` on the body) | |

After a claim, the winner runs, in order: the checks, `INCR seq`, `HSETNX` the body, the indexes, the open-set
`ZREM`/`ZADD`, then the record (`SET session`). A crash leaves a claim whose writes are incomplete.
**`repair` only completes the claimed write**: it adds missing indexes, and a missing body is written from the
claim value. Repair never chooses a winner, because the claim already did. It runs lazily (a reader that finds
a claim with no body after 60 s completes it) and nightly. Results in this mode carry `atomic: false`.

**Rejected: "lowest seq wins"** (rev 1). Two callers could both write entries and readers would have to hide
the loser. A claim decides before anything is visible.
**Rejected: MULTI/EXEC as the primary path.** Upstash REST does expose `/multi-exec`, but it can't express
"check, then write" (there's no WATCH over REST). Every backend that offers it also allows scripts, and the
Polar bridge offers neither.
**Rejected: Redis Functions.** They need Redis 7 and a `FUNCTION LOAD` step per backend.

### 2.5 Upstash notes (verify before phase A merges)

- `ZRANGE … BYSCORE REV LIMIT` needs Redis 6.2+; the probe falls back to `ZREVRANGEBYSCORE`.
- `#!lua flags=no-writes` only on Redis 7+ (probe step 2).
- **Request size**: Upstash caps the size of each request and response, and the cap depends on the plan.
  Pages are therefore capped at **1 MB of bodies** as well as by count (a page that's too big ends early with
  `next_cursor`). `HMGET` calls are split into groups of 100 ids.
- **Billing**: confirm whether Upstash counts a script as one command or counts each `redis.call` inside it.
  A handoff is about 12 calls. Budget the free tier on the per-call assumption until confirmed.

---

## 3. D3: tool contract 1.0

### 3.1 Version

- `serverInfo = { name: "logmem", version: "1.0.0" }`.
- `initialize` adds `capabilities.experimental["logmem/contract"]`:
  `{ version: "1.0", entry_schema: 1, writes: "atomic"|"sequenced", pipeline, search: "keyword" }`.
- The first line of `instructions` is `LogMem contract 1.0.`
- `tools.schema.json` gains `"contract": "1.0"`; `spec:check` enforces it.
- Minor versions only add. A rename or removal is a major bump. Deprecations live at least one minor version.

### 3.2 Common shapes

| Rule | Shape |
|---|---|
| List reads | in: `limit` (default/max per tool), `cursor` (reverse) **or** `after` (forward poll); out: `next_cursor`, `null` at the end of a reverse read. A forward read always returns a cursor to poll from |
| Entry writes | in: `idempotency_key?`; out: `id`, `seq`, `deduped`, `atomic` |
| Errors | `{ ok:false, tool, code, error:"<message>", retryable, details? }` + `isError`. `error` stays a string so v0 readers keep working |

Error codes: `invalid_argument`, `not_found`, `unknown_agent`, `reserved_kind`, `not_open`, `already_accepted`,
`already_decided`, `idempotency_conflict`, `conflict`, `forbidden`, `too_large`, `quota_exceeded`,
`rate_limited`, `backend_unavailable` (retryable), `backend_refused`, `degraded`, `internal`.

### 3.3 Tools

| Tool | 1.0 change |
|---|---|
| `logmem_start` | goes through the `shift` script; adds `brief.pending` |
| `logmem_brief` | log limit 20/50 + `next_cursor`; `handoffs_to_me` from `open:handoff:{me}`; `my_asks` (`waiting_on` + `answered:{me}` with `verdict`) |
| `logmem_recap` | reads the shift index (§5.1) |
| `logmem_note` | `idempotency_key`; `kind: decided` and `kind: redacted` → `reserved_kind`; `kind: accepted` routes to `accept` with a `deprecation` field |
| `logmem_handoff` | `to` must be on the roster (`unknown_agent` + `did_you_mean`); returns `id`, `seq` |
| `logmem_accept` **new** | in: `handoff` (id or trail), `note?`, `idempotency_key?`. Only the addressee can accept |
| `logmem_ask` | returns `id`; no `status` field written |
| `logmem_pending` **new**, R | in: `of` ∈ `handoff`·`ask`, `to?`, `limit` 20/100, `cursor` |
| `logmem_decide` **new**, human-only | in: `ask` (id), `verdict` ∈ `approve`·`reject`, `comment?`. Listed only for a human approver principal. The U3 web Approve/Reject buttons call the same core function. Writes `decided`, `by: human:<id>`, `decides: <ask id>` |
| `logmem_status`, `logmem_bio`, `logmem_follow` | unchanged: no entry, so no `id`/`seq`/`idempotency_key` |
| `logmem_view`, `logmem_open` | `limit` (10/100, 50/200), `cursor` |
| `logmem_feed` | `refs` ≤ 16, `limit` 50/200, `cursor` or `after` (polling), `since` |
| `logmem_roster`, `logmem_jobs` | `limit`/`cursor` (SSCAN); `jobs` returns `[{id, title, stage, owner}]` (breaking) |
| `logmem_recall` | `limit` 5/50; `mode: keyword`, bounded (§5.3) |
| `logmem_remove` | refuses `:log` and `:e:` keys |
| `logmem_connection` | adds `contract`, `capabilities`, `schema_version` |

That makes 23 tools for agents, 24 for approvers. The `acmi_*` compat tools are unchanged.

**Rejected:** agent-writable `decided` checked by `by`, because `by` is self-asserted (S2; the v0.x hotfix
already closes this). Hard-blocking the asker while an ask is open (O3) moves to v1.1; v1.0 puts `waiting_on`
into the asker's write results.

### 3.4 Deprecations from v0

- `note kind:accepted` → use `accept`.
- `note kind:decided` → refused.
- Approval `status` field → derived from `open:ask`.
- Client `ts` → dropped.
- Unbounded `feed` → capped.
- `remove` on log or bucket keys → refused.
- `jobs` returning bare ids → returns objects.
- `_o` → gone.

Each deprecated path that still works returns `deprecation: "<use instead>"`.

---

## 4. D4: hosted layout

### 4.1 Keys and scale ceiling

`lm:{space}:…` puts a whole space in **one cluster slot**, so every script is cluster-legal. The ceiling is
therefore **one space per shard**: a single space can't use more memory or throughput than one shard has.
Scale-out happens across spaces, not within one. The seq `INCR` is not a hot key in any meaningful sense,
because every write in the space already lands on that same shard. If a space ever outgrows a shard, it gets a
dedicated instance; splitting a space is out of scope.

Space names forbid `{`, `}` and `:`. These namespace words are reserved: `e seq activity days logs shift open
answered idem claim redactions rseq outbox meta session mirror registry space`.

| Key | Purpose |
|---|---|
| `lm:{s}:logs` | ZSET `"ns:id"` → last ts. Replaces `SCAN …:log` |
| `lm:{s}:shift:{shift}` | ZSET of the shift's entry ids, scored by seq, TTL 30 d (U5) |
| `lm:{s}:open:handoff:{agent}` · `open:ask` · `answered:{agent}` | open items (U6) |
| `lm:{s}:claim:accept:{id}` · `claim:decide:{id}` · `session:{sid}:v{n}` | claim keys (§2.4) |
| `lm:{s}:outbox:mark` · `outbox:mark:redactions` | archive watermarks (§4.4) |
| `lm:{s}:meta` | HASH: `schema_version`, `plan`, `retention_hot_days`, quotas, `status`, `entries_total` |
| `lm:{s}:space:audit:log` | redaction and admin audit log |
| who/now/recap/follows/shifts/sessions, `{ns}:list`, `session:{sid}`, `mirror:retry` | as v0, re-prefixed |

**No SCAN, no whole-bucket reads.** `scanKeys` in `view.mjs` and the `keywordRecall` loops leave request paths.
A test greps `src/core`, `src/http` and `api/` for `SCAN`, `KEYS`, and `HGETALL`/`HLEN`/`HSCAN` on `:e:` keys,
and fails on any hit outside `scripts/`.

### 4.2 Space registry

In v1.0, `lm:{s}:meta` holds defaults and is written by the server on the first write.

In v1.1, the registry moves to Postgres as the control plane, and `meta` becomes its projection:

```jsonc
{ "space": "madez", "owner_account": "acct_…", "plan": "free" | "team" | "agency",
  "backend": { "kind": "hosted" | "byo", "region": "eu-central", "redis_ref": "sec_…" },  // secret id only
  "archive": { "enabled": true, "target": "jsonl" | "jsonl+pg" | "none" },
  "retention": { "hot_days": 30, "history_days": 365 },
  "quotas": { "entries_per_day": 5000, "max_entry_bytes": 16384, "agents": 10, "storage_mb": 256 },
  "schema_version": 1, "contract": "1.0", "compat": { "acmi": false, "mirror": false },
  "status": "active" | "suspended" | "migrating" | "deleting", "created_at": "…", "updated_at": "…" }
```

### 4.3 History, search and export (v1.1)

1. **First: JSONL in object storage.** `archive/{space}/{yyyymmdd}.jsonl.gz`, one file per day bucket, written
   by the outbox. It covers `/api/export` (P3), delete-space and backup, and it's the precondition for
   trimming.
2. **Then: Postgres** for history past the hot window and full-text search:

   ```sql
   create table entries (space text, id char(26), seq bigint, ts timestamptz, kind text, by_ref text,
     trail text, origin text, logs text[], body jsonb, redacted_at timestamptz,
     tsv tsvector generated always as (to_tsvector('simple',
       coalesce(body->>'summary','') || ' ' || coalesce((body->'payload')::text,''))) stored,
     primary key (space, id));
   -- indexes: (space, seq), gin(logs), gin(tsv); RLS: space = current_setting('app.space')
   ```

**Why Postgres in the end.** Upstash has no RediSearch, history in RAM is expensive, and export and analytics
are SQL problems. **Rejected:** everything in Redis (no full-text search, RAM cost). **Rejected:** Postgres as
the primary store (an extra hop on every serverless write, and it breaks BYO Redis). **Rejected:** Postgres in
v1.0, which is too much scope before the core is proven. v1.0 ships the hooks only.

### 4.4 Outbox (hooks in v1.0, worker in v1.1)

- **Entries**: `ZRANGE activity (mark +inf BYSCORE LIMIT 0 500` → group by bucket → `HMGET` → write. The mark
  advances only through **contiguous** seqs. A gap is held for a **settle window** (60 s in sequenced mode;
  in atomic mode a gap can only come from a script failing after `INCR`, which the checks-first rule prevents, so it is settled at once), then skipped and
  recorded in `lm:{s}:outbox:gaps` so `repair` can backfill it if the body appears.
- **Redactions**: a separate stream and mark. `ZRANGE redactions (mark:redactions +inf BYSCORE`, scored by
  `rseq`, rewrites the entry in every sink, and that day's JSONL file is rewritten within 24 h.
- Writes are idempotent upserts keyed by `(space, id)`, so a crash just replays.

### 4.5 Hosted and BYO side by side

| | Hosted | BYO |
|---|---|---|
| Hot store | LogMem Redis: shared for free/team, dedicated instance for agency | customer's Redis (creds sealed per S3) |
| Writes | `atomic` required | `atomic`, or `sequenced` with claim keys |
| Archive | JSONL (v1.1), then Postgres | off by default; opt in to LogMem's archive |
| Recall | keyword, then FTS | keyword over the hot window |

### 4.6 Tenant isolation, plainly

- **Hosted shared tier:** one credential, held by the LogMem server, reaches every space in that Redis.
  Isolation is enforced only by the server: the space is bound by the authenticated connection, `lmKey` is the
  single key builder, segments are validated. A bug there is a cross-tenant read. Mitigations: a cross-space
  fuzz test, Postgres RLS as a second check on history, and Redis ACL users scoped to `~lm:{s}:*` where the
  provider supports them.
- **Dedicated tier:** a separate instance and separate credentials per customer. That's real isolation.
- **BYO:** anyone holding the creds reads every space in that Redis. Spaces there are namespaces, not
  boundaries.
- **The fleet today:** one bridge token reaches all of `acmi:*` and `lm:*` (S1). There's no isolation until S1
  is fixed.

---

## 5. U5, U6, U8

### 5.1 Auto-Recap correctness (U5)

v0 builds the Recap from the agent's own log only. That misses job and channel writes and handoffs the agent
sent. Two concurrent stateless calls after an idle gap can also both write a Recap.

v1:

1. Every append adds its id to `lm:{s}:shift:{entry.shift}`. The Recap reads that set (cap 500) plus the
   bodies, so every entry the shift wrote counts once, wherever it landed. `recap` and `started` entries are
   excluded from the counts.
2. Every transition goes through `shift`: a version check plus the `session:{sid}:v{n+1}` claim. Exactly one
   caller writes the Recap; the other gets −40 and adopts the winner's record.

### 5.2 Open handoffs and asks (U6)

- `handoff` → `open:handoff:{to}`; `accept` removes it and writes the claim.
- `ask` → `open:ask`; `decide` removes it, writes the claim and adds to `answered:{asker}`.
- Brief, `logmem_pending`, the overview "waiting" count and the dogfood "unanswered for more than 24 h" check
  read these sets, not the last 200–500 entries.
- Open items are pinned: the trimmer keeps a day bucket while any id in it is still in an open set (that day
  waits), and the JSONL archive has it anyway.
- Migration fills the sets with the v0 rule: a handoff with no `accepted` whose origin is its trail, and an
  approval with no `decided`.

### 5.3 Bounded reads (U8)

| Read | v0 | v1 |
|---|---|---|
| any log | `ZRANGEBYSCORE -inf +inf`, sliced in JS | `page_ids` + per-bucket `HMGET`, seq cursor |
| overview, log view | SCAN every `:log` | `activity` `REV LIMIT 200` |
| channels list | `list` + one read each | `lm:{s}:logs` filtered to `channel:` |
| settings key count | SCAN | `meta.entries_total` |
| compat legacy log | `ZRANGE 0 -1` | bounded to the ms score window `[since, now]` with `REV LIMIT`. The 74 legacy entries scored in ns/µs/s fall outside it; they appear through the migrated copy |
| compat dedupe | `ts|trail|summary` signature | skip `mirrored_from: "lm"` twins |
| recall | every log × 500 | v1.0: keyword over the last 2,000 `activity` ids. v1.1: Postgres FTS |

---

## 6. D5: retention and ACMI sunset

### 6.1 Hot window (trimmer in v1.1)

The default hot window is 30 days (free) or 90 days (team, agency). BYO is off (never trimmed) unless the
customer sets it.

The daily trimmer runs per space, and only when the archive is on:

1. A day bucket is eligible when it's older than the window, the entries mark has passed its last seq, the
   redactions mark is current, and none of its ids are in an open set.
2. For an eligible bucket, `UNLINK lm:{s}:e:{day}` (falling back to `DEL`), then trim logs and `activity` with
   `ZREMRANGEBYSCORE -inf <first seq of the next kept day>` from `days` where that's allowed. Otherwise it
   relies on the lazy `ZREM` on read (§2.3).

Who, Now, Recap, follows and rosters are never trimmed. Pages that reach the window return
`details.archived: true`, and v1.1 continues them from the archive.

### 6.2 ACMI sunset

| Step | Target | Conditions (all must hold) |
|---|---|---|
| Mirror off | **2026-12-01** | dogfood GO; ACMI `--apply` + field-level `--verify` clean; every VM writer (opencode, codex, ops-center, bentley, grok) reads LogMem directly or through compat |
| Compat reads off | **not before 2027-01-15** | zero native `acmi:madez:*` writes (entries without `mirrored_from`) for **14 consecutive days**, measured by the daily check; a final delta pass |
| Compat code deleted | **by 2027-03-31** | the above plus a Mikey GO. If the conditions aren't met by then, compat stays bounded (§5.3) and the date moves only by a written decision |

Legacy `acmi:*` cleanup stays a separate HITL task.

---

## 7. Phased plan

Prerequisites: **O1** (required CI on PRs) and **S2** (v0.x hotfix, T0-b PR). The v1 cutover happens after the
dogfood gate (Oct 21). Nothing changes the key layout during the 7-day pass window.

### v1.0 (minimum)

| Phase | Ships | Tests | Migration / dry run |
|---|---|---|---|
| **A′. Runner** | `script()`, `pipeline()`, probe (scripts, 6.2/7, ZPOPMIN, pipeline), node-redis passthrough, claim-key sequenced mode | EVALSHA → NOSCRIPT → EVAL; 403 → sequenced; `REQUIRE_SCRIPTS` → refused. **Differential**: random op sequences give the same key state under Lua (local Redis :6399) and sequenced mode. **Crash injection**: kill sequenced mode after each step, run repair, and exactly one winner remains with every index present | `bridge-probe --scripts` on `lm:probe:*` (HITL run on Polar) |
| **B. Entry v1** | ULID, seq, day buckets, `{s}` keys, activity, days, logs index, idem, meta counters, reserved namespaces | seq-ordered pages with exclusive cursors; replay exactly-once; idempotency conflict; 16 KB cap; per-bucket HMGET grouping; cross-space fuzz | `migrate-v0-v1 --dry-run` on `lm:madez:*` (read-only): groups, `ungrouped_lookalikes`, report hash |
| **C′. Workflows** | `append`, `handoff`, `accept`, `ask`, `decide`, `shift`; `redact` as an admin script; open, shift and answered indexes; Brief/Recap rewired | **Every status code** reached by a test. Checks-before-writes: each failing check leaves the key space byte-identical. Races (in both modes): 2 accepts → 1 wins, the other gets `already_accepted`; 2 decides → `already_decided`; 2 idle touches → 1 Recap. Recap counts job and channel entries. Asker mismatch is refused | dry run reports the open sets it would build |
| **D′. Contract 1.0** | §3 tools, errors, version, seq forward cursors (`after`), `page_ids`, view.mjs without SCAN, bounded compat | `spec:check`; forward polling under concurrent writes never skips; settle rule; no-SCAN / no-HGETALL grep test; ACMI conformance 30/30 + 35/35; Field Notes day end to end | n/a |
| **E. Migration** | freeze, `--apply` (HITL), field-level `--verify`, delta pass, cross-source dedupe, `migrate-v1-v0` rollback | verify catches a planted one-field diff; the delta pass converges; rollback round trip | v0 keys kept 30 d |
| **U3** | web Approve/Reject → `decide` | approver-only; double-click → `already_decided` | n/a |
| **U1** | `npx github:madezmedia/logmem` install path and matching snippets | a clean-machine smoke test | n/a |

### v1.1

| Phase | Ships |
|---|---|
| F. Archive | outbox worker, JSONL day files, `/api/export`, delete-space, redaction propagation |
| G. Postgres | history, FTS recall (`mode: fts`), RLS |
| H. Retention and registry | trimmer (bucket `UNLINK`), Postgres registry + `meta` projection, quotas, hosted provisioning |
| I. Product | U4 webhooks, U2 real onboarding probe |
| J. Sunset and hardening | mirror off, compat removal path, O3 enforcement, O4 signed session ids, nightly `repair` |

Each v1.1 phase ships with a `--dry-run` that prints what it would write or delete, plus replay and
idempotency tests.

## 8. Risks

1. **The fleet bridge blocks EVAL**, so `madez` runs sequenced. Claim keys keep the outcome exactly-once, but
   multi-step writes become visible in pieces until repair completes them. Mitigation: Mikey M1.
2. **Upstash limits** (request size, script billing, Redis version) are unverified. §2.5 must be checked
   before A′ merges.
3. **One space per shard** is a hard ceiling. That's fine for the fleet (36k entries is about 20 MB); a large
   agency space needs a dedicated instance.
4. **Late history imports** sort as new, because seq is commit order. Mitigation: import everything at the
   cutover; anything missed needs an explicit decision.
5. **Two migrations plus compat merge.** Mitigations: the freeze, field-level verify, cross-source dedupe and
   the rollback script.
6. **Shared-credential hosting** puts a single code path between tenants (§4.6).
7. **Human-only decide** rests on admin auth until U7 (accounts with roles).


## 9. Critique items: decision, trade-off, migration

**Provenance.** No review was posted on PR #5. This list was **reconstructed from the rev-2 commit message**
(`53c833e`), which names the ten fixes made after an out-of-band critique. Each item points to the section that
holds the full design. "Today" means the v0 code on `feat/site-pass-a`:
- log ZSETs whose member is the entry JSON, led by a `_o` same-ms ordinal and scored by ts in ms;
- dedupe by check-then-write (`ZRANGEBYSCORE ts ts`, compare, then `ZADD`) in `store.mjs` `append`;
- one HTTP request per command (`redis-rest.mjs`), and a fixed command switch in `redis-native.mjs`.

Every item has to run on BYO Redis (Upstash REST and TCP) without Postgres.

### C1. Claim-key sequenced mode (§2.4)

- **Decision.** Where scripts are refused, the outcome is decided by one `SET … NX` claim, written before
  anything entry-related. The claim value carries the full intended write, and `repair` only completes a
  claimed write; it never picks a winner. This replaces rev 1's "lowest seq wins".
- **Trade-off.**
  - In sequenced mode, a multi-step write (entry, then indexes, then open sets) is visible in pieces until it
    finishes or repair runs. Results say `atomic: false`.
  - Claim keys cost memory for the hot window plus 7 days.
  - We take on a repair path (lazy at 60 s, plus nightly) that atomic mode doesn't need.
- **Migration from today.**
  - Today, `accept` and `decided` are plain `note` appends with no exclusivity, so two accepts both land.
  - Phase A′ adds `runner.script()`/`pipeline()`/`caps` and the claim path behind the same store API.
  - `migrate-v0-v1` writes `claim:accept:{hid}` and `claim:decide:{aid}` for every v0 handoff and ask that
    already has an `accepted` or `decided` entry. A late duplicate after cutover then gets `already_*`, not a
    second winner.
  - `madez` runs in this mode until M1 is answered.

### C2. Checks before writes, with status codes (§2.1–§2.2)

- **Decision.** Every script runs all `TYPE`/membership/body checks before its first write, and uses only
  can't-fail commands afterwards. It returns a numeric status that maps 1:1 to a coded tool error.
- **Trade-off.**
  - There is an extra `TYPE` call per written key.
  - Scripts get longer and must be tested so that every code is reached (Phase C′).
  - The status table becomes contract surface: new codes are additive and must not change existing ones.
- **Migration from today.**
  - Today a `WRONGTYPE` surfaces mid-write as a thrown error after earlier commands have already applied
    (`append` does `ZADD` then `index()` then `mirrorWrite`).
  - v1 turns that case into `−2` with nothing written.
  - The type faults already present in legacy data (PLAN.md: 45 timeline-as-STRING, 5 spawns-as-STRING,
    1 profile-as-HASH) are fixed by the migration copy, never by request paths.
  - Tool errors keep `error` as a string, so v0 readers keep working while gaining `code`.

### C3. Seq cursors, not (ts, id) (§1.3)

- **Decision.** Every log and `activity` is scored by a space-wide `seq`. All cursors are exclusive seq
  ranges, forward and reverse; `since` filters on `ts` while paging.
- **Trade-off.**
  - One `INCR` key per space serializes writes. That's free inside one slot (C8), but it rules out splitting a
    space.
  - Scores are no longer times, so a time range needs a paged scan with a ts stop, not one `ZRANGEBYSCORE`.
  - History imported after cutover sorts as new (Risk 4).
- **Migration from today.**
  - Today `readLog` loads the whole ZSET (`ZRANGEBYSCORE -inf +inf`), re-sorts in JS by `(ts, _o, read order)`
    and slices.
  - Migration assigns seq in global `(ts, _o)` order across v0 and the ACMI copy, so v1 order equals v0's
    displayed order.
  - `sinceMs`/`untilMs` callers move to reverse paging with a ts stop. `_o` is dropped (§1.6 step 2).

### C4. Outbox settle rule (§1.3, §4.4)

- **Decision.** Forward readers and the outbox mark advance only over contiguous seqs.
  - In sequenced mode, a gap is held for 60 s, then skipped and recorded in `outbox:gaps`.
  - In atomic mode, checks-first means there are no in-flight gaps, so the rule never waits.
- **Trade-off.**
  - In sequenced mode, a forward poller can lag up to 60 s behind a crashed write.
  - A body that repair writes after its gap was skipped is not re-delivered to pollers that have moved past;
    it is reached by reverse reads and by the outbox's gap backfill.
- **Migration from today.**
  - There is no outbox today: `mirror.mjs` writes the ACMI twin synchronously inside `append`.
  - v1.0 ships only the hooks (seq, `activity`, marks, `redactions`), and the mirror stays synchronous.
  - The worker that drains marks arrives in v1.1 (Phase F). Nothing to backfill, because marks start at the
    cutover seq.

### C5. Day-bucketed entry bodies (§1.2)

- **Decision.** Bodies live once, in `lm:{s}:e:{yyyymmdd}` (HASH id → JSON). The bucket comes from the ULID
  time, and logs hold ids.
- **Trade-off.**
  - A page that spans N days costs N `HMGET`s (pipelined, groups of 100).
  - A reader must derive the bucket from the id, so ids can't be opaque random strings.
  - Retention can only drop whole days.
  - In return, a fan-out is stored once, redaction touches one field, and trimming is an `UNLINK`, not
    millions of `HDEL`s.
- **Migration from today.**
  - Today a fanned-out handoff is a separate JSON member in every log it touched, each with its own `_o`.
  - Migration groups byte-equal copies into one body (§1.6 step 3), mints its ULID from `ts`, writes it to the
    day bucket, and puts the id in each log.
  - v0 keys are untouched, so rollback stays possible (§1.6 step 7).

### C6. Stricter migration (§1.6)

- **Decision.** The migration is built from:
  - a freeze, or a delta pass that converges;
  - grouping only when byte-equal, with lookalikes reported;
  - a field-by-field `--verify`;
  - cross-source dedupe of `mirrored_from: "lm"` twins;
  - `migrate-v1-v0` for the 7-day rollback window.
- **Trade-off.**
  - About 15 minutes of paused dogfood writes, or repeated delta passes.
  - Near-duplicate fan-outs that differ by a byte stay separate entries, so v1 can hold a few more entries
    than the true count.
  - Rollback after cutover loses v1 writes unless the reverse copy runs.
- **Migration from today.** This item *is* the migration path. It reads only the `{ns}:list` sets (no SCAN),
  runs `--dry-run` first with a report hash that `--apply` requires (HITL), and normalizes legacy timestamp
  units per §1.7.

### C7. Upstash notes (§2.5)

- **Decision.**
  - The runner probes once per instance for scripts, Redis 6.2/7, `ZPOPMIN` and `/pipeline`, and picks
    command forms to match.
  - Pages are capped at 1 MB of bodies as well as by count.
  - `HMGET` calls are split into groups of 100.
- **Trade-off.**
  - More round trips on large pages.
  - Two Upstash facts are unverified: the request-size cap per plan, and whether a script bills as one command
    or per `redis.call`. Free-tier budgets assume per-call (about 12 calls per handoff) until confirmed.
- **Migration from today.**
  - `redis-rest.mjs` sends one request per command and has no pipeline. v1 adds `/pipeline`.
  - `redis-native.mjs` has a fixed command switch with no `EVAL`/`EVALSHA`. v1 adds a `default:` passthrough
    to `sendCommand`.
  - Both have to be verified against a real Upstash database and a real TCP Redis before Phase A′ merges.
  - Nothing changes for Polar or the fleet bridge beyond the probe result.

### C8. Slot ceiling (§4.1)

- **Decision.** Keys are `lm:{space}:…`, so a whole space sits in one cluster slot and every script is
  cluster-legal.
- **Trade-off.**
  - One space can't outgrow one shard. Scale-out is across spaces.
  - A space that outgrows a shard needs a dedicated instance; splitting a space is out of scope.
  - The fleet (about 36k entries, roughly 20 MB) is far below this.
- **Migration from today.**
  - Today's keys are `lm:madez:…` with no braces.
  - v1 keys `lm:{madez}:…` don't overlap them, so migration is a copy, not a rename, and v0 stays readable for
    rollback.
  - On non-cluster BYO Redis the braces are inert.

### C9. Postgres deferred to v1.1, behind a JSONL archive (§4.3)

- **Decision.**
  - v1.0 has no Postgres.
  - The first archive (v1.1, Phase F) is JSONL day files in object storage, for export, delete and backup.
  - Postgres history and FTS follow in v1.1 (Phase G), for hosted spaces and for BYO spaces that opt in.
- **Trade-off.**
  - v1.0 recall is keyword-only over the last 2,000 `activity` ids.
  - No trimming happens until an archive exists, so hot data grows without bound in v1.0. At fleet scale
    that's acceptable.
- **Migration from today.**
  - There's nothing to move: no Postgres exists today.
  - BYO stays Redis-only end to end, which keeps the requirement that v1 runs on BYO Upstash/TCP before any
    hosted Postgres.
  - `keywordRecall`'s full-log loops are replaced by the bounded `activity` read in Phase D′.

### C10. v1.0 re-scoped (§7)

- **Decision.**
  - v1.0 is A′ (runner), B (entry v1), C′ (workflows), D′ (contract 1.0), E (migration), U3 (web
    approve/reject) and U1 (install path).
  - Archive, Postgres, trimmer, registry, webhooks, onboarding probe and sunset hardening move to v1.1.
  - Prerequisites: O1 (CI gate) and S2 (the T0-b hotfix, PR #8).
- **Trade-off.**
  - v1.0 has no export, retention, notifications or hosted provisioning, so it is a BYO and fleet release,
    not a hosted launch.
- **Migration from today.**
  - The v0 server keeps serving `lm:madez:*` through phases A′–D′. They land behind the store API and are
    exercised against `lm:{probe}`/local Redis.
  - Cutover happens only at phase E, after the dogfood gate (Oct 21). The key layout doesn't change during the
    7-day pass window.

## 10. Decisions for Mikey

Only questions this design can't settle on its own:

1. **M1: Bridge scripts.**
   - Will the fleet bridge allow `EVAL`/`EVALSHA`/`SCRIPT LOAD`, `ZPOPMIN` and a pipeline endpoint?
   - If not, is claim-key sequenced mode (C1) acceptable for `madez` until S1 replaces the bridge?
   - This blocks the Phase A′ default for `madez`.
2. **M2: Timestamp unit.**
   - The fleet ruling is ms storage with compat normalizing ns and s on read (§1.7), but a fleet note claims ns.
   - Confirm ms and retire or correct that note, or overrule it.
   - Until then the design proceeds on ms. The answer changes §1.7 and the archive column types, not ordering.
3. **M3: Sunset.**
   - Are mirror-off on 2026-12-01 and compat removal between 2027-01-15 and 2027-03-31 acceptable (§6.2)?
   - Who drives the VM-agent cutover that the 14-day zero-native-writes condition depends on?
4. **M4: v1.1 storage (not blocking v1.0).**
   - Which object store for the JSONL archive, and which Postgres provider?
   - Are the defaults right: hot window 30 days (free) or 90 days (team, agency), history 365 days on free,
     BYO archive off?
   - Needed before Phase F starts.
