# Migration plan: `acmi:madez:*` → `lm:madez:*`

Owner: claude-engineer · Status: **plan + dry run only** · Writes: **none** · `--apply`: not implemented (HITL, Mikey)

## Dry run, 2026-10-11 (live, read-only)

`scripts/migrate-dry-run.mjs` ran against the Polar HTTPS exec (`acmi-redis-u70402…/bridge/exec`) through a
read-command allowlist (SCAN, TYPE, GET, HGETALL, SMEMBERS, LRANGE, ZRANGE, ZCARD, EXISTS, DBSIZE, PING, TTL).
It took 3 min 0 s. Full report: [`dry-run-2026-10-11.json`](dry-run-2026-10-11.json).

| | Count |
|---|---|
| Keys in DB | 3,184 |
| `acmi:madez:*` scanned | 3,165 |
| Mapped to an `lm:` target | **1,677** |
| Unmapped (left alone) | 1,488 (id-has-colon 1,108 · unknown slot 366 · no id 14) |
| `lm:*` keys already present | **0** (clean target) |
| Timeline / spawn entries | 36,103 |
| Entries rescored to ms | **74** (ns 69 · µs 3 · s 2) |
| Entries already ms | 35,941 |
| Scores < 1e9 ("small", left as-is, need eyes) | 88 |
| Kinds remapped to LogMem words | 9,490 (alias preserved via `acmi_kind`: 743) |
| Kinds passed through unchanged | 25,462 (907 distinct) |
| Field renames (correlationId/parentCorrelationId/source/tenant_id/speaker_type) | 66,498 |
| Collisions after rescore | 0 |
| Unparseable members | 13 |
| `signals` STRING → `now` HASH fields | 2,875 across 431 keys |
| Type mismatches | timeline-as-STRING 45 · spawns-as-STRING 5 · profile-as-HASH 1 |

Mapped by target slot: who 543 · log 575 · now 431 · recap 48 · list 29 · shifts 26 · sessions 17 · follows 8.

Top rescore keys: `thread:agent-coordination` 46 · `agent:opencode` 19 · `agent:claude-engineer` 2 · `mission:folana-journal-pipeline` 2.

Top remaps: heartbeat→ping 6,905 · coord-note→memo 806 · milestone-shipped→done 394 · task-delegation→handoff 225 · handoff-ack→accepted 195.

## What this says about the ts-unit work (deliverable 1)

- ns-scored members are **still live**: 69 entries, 46 of them on `thread:agent-coordination`. So **no rescore migration has been applied.**
- They are only 0.2% of entries, but they sort as the newest, so they pin themselves to the top of every ACMI `ZREVRANGE` "recent" read until the read path normalises.

## Steps (when Mikey says go)

1. **Freeze**: announce on `thread:agent-coordination`. No config flips yet; fleet keeps writing `acmi:*`.
2. **Copy** (new PR, `--apply` behind an explicit flag plus a confirmation of the dry-run hash). For each mapped key, write the `lm:` target in the LogMem shape. Legacy keys are never modified or deleted.
3. **Verify**: re-run the dry run in `--verify` mode. Every mapped source must have a target with equal member counts (minus exact duplicates), all scores in ms, and zero writes to `acmi:*`.
4. **Cut over**: flip agents one at a time to the LogMem server with `LOGMEM_ACMI_COMPAT=1`. Compat reads merge `acmi:*`, so anything written to `acmi:*` after the copy still shows up.
5. **Drain**: once every writer is on LogMem, run a delta copy for entries newer than step 2.
6. **Retire**: legacy key cleanup is a separate HITL task. It is not part of this plan.

## Decisions needed (from spec §8)

- **O2, colon ids (1,108 keys).** Proposal: join extra segments with `.`, and collapse `agent:agent:<id>`. Until that's decided they stay unmapped, and compat reads can't see them through `logmem_*`.
- **Small scores (88).** List them and decide fix-or-keep. Likely fixtures or relative clocks.
- **String-typed timelines (50).** Parse the JSON array into ZSET members on copy, or leave them unmapped. The dry run reports each key.
- **Junk namespaces** (`--action`, `undefined`, `acmi.madez.*` as a namespace): exclude them from the copy.
