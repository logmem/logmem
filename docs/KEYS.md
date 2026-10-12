# Key layout (DRAFT, for spec review)

```
lm:{space}:{ns}:{id}:{slot}
lm:{space}:{ns}:list          SET of ids
lm:{space}:session:{sid}      shift bookkeeping (STRING JSON, 7-day TTL)
lm:{space}:ask:{trail}        ask registry: {hash, asker, where, ts} of the one canonical ask (STRING JSON, SET NX; protected)
lm:{space}:decision:{trail}   set-once claim {v, verdict, by, ts, ask_hash, sig, entry}: the full signed decided entry that settled the ask (STRING JSON, SET NX; an admin re-answer replaces one that no longer verifies after a key rotation; protected)
lm:oauth:{client|code|token|refresh}:{x}   OAuth, outside every space
```

| ns | ACMI ns |
|----|---------|
| `agent` | `agent` |
| `channel` | `thread` |
| `job` | `work` |
| anything else | same |

| slot | type | ACMI slot | notes |
|------|------|-----------|-------|
| `who` | STRING (JSON) | `profile` | |
| `now` | HASH (field → JSON) | `signals` (STRING JSON) | LogMem merges; `acmi_signal` replaces |
| `log` | ZSET, score = ts **ms** | `timeline` | member = stable JSON, leads with `_o` (same-ms ordinal) |
| `recap` | STRING (JSON) | `rollup:latest` | agents |
| `follows` | HASH | `active_context` | agents; keys are refs like `job:issue-14` |
| `shifts` | ZSET | `spawns` | agents |
| `sessions` | SET | `sessions` | jobs |

## Entry shape

```json
{ "_o": "000000", "ts": 1791731538741, "kind": "accepted", "by": "agent:quill",
  "via": "codex", "byline": "quill (via codex)", "trail": "...", "origin": "...",
  "shift": "quillShift-1791731500000-<24 hex>", "summary": "...", "payload": {} }
```

`acmi_kind` is present only when the entry came in under an ACMI alias
(e.g. `task-delegation` → `handoff`), so compat reads return the original.

## Timestamps

Writes: ms. Reads: scores and `ts` normalised with `normTs` (ns, µs, and
epoch-seconds in 1e9..1e11 become ms; smaller values are left alone).

## Open questions for the spec

1. Slot words (`who/now/log`) vs keeping ACMI slot names.
2. Should compat mode dual-write to `acmi:*` during cutover? (Currently no.)
3. Session ids are client-supplied on HTTP; any client in the same space can
   resume another's shift by reusing its id. Same trust boundary as the space,
   but worth a decision.
