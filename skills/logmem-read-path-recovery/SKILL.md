---
name: logmem-read-path-recovery
description: Use this instead of the ACMI read-path, WRONGTYPE, bridge-outage and fallback skills (ACMI). Diagnose and recover when LogMem or Redis reads fail, come back empty, return WRONGTYPE, or the server reports degraded mode. Read the right key shape, fall back in a fixed order, never invent state, and report the outage once.
---

# LogMem read-path recovery

Reads fail in a few known ways. Most "everything is down" alarms are a reader using the wrong command for a key's type. Diagnose first, then fall back in a fixed order, and report what you could not read. Never fill a gap with old state.

## When this skill applies

- A LogMem tool returns `degraded: true`, or `logmem_connection` shows the in-memory backend.
- A read returns WRONGTYPE, "unknown command", HTTP 403, or an empty result that should not be empty.
- An audit says "0 of N agents healthy" or "0 entries" and nothing else looks wrong.
- The bridge or Redis times out.

## 1. Check the server first

```text
logmem_connection {}
```

- `degraded: true` or backend `memory`: the server lost Redis and is answering from memory. Its reads are not the team's memory, and its writes are not saved. Stop writing, then go to step 4.
- A normal backend: LogMem itself is fine. Go to step 2.

## 2. Read with the right command for the key's type

LogMem keys are `lm:{space}:{ns}:{id}:{slot}`. Always run `TYPE <key>` before reading a key directly.

| Key | Type | Read with |
|---|---|---|
| `...:who` | string (JSON) | `GET`, then parse |
| `...:now` | hash (each field holds JSON) | `HGETALL` |
| `...:log`, `...:shifts` | sorted set, score in milliseconds | `ZRANGEBYSCORE key -inf +inf WITHSCORES` |
| `...:recap` | string (JSON) | `GET` |
| `lm:{space}:{ns}:list` | set (the index) | `SMEMBERS` |

Older ACMI keys (`acmi:{space}:*`) drift between types:

- `acmi:...:signals` and `...:profile` may be a JSON string or a hash. Use `GET` first. If it is empty, use `HGETALL` and turn the flat `[k, v, ...]` list into an object.
- The thread and work timelines and `acmi:{space}:bus:events` are sorted sets. List or stream commands (`LRANGE`, `LPUSH`, `XRANGE`) on them return WRONGTYPE.
- On WRONGTYPE for one key, skip that key and continue. Never abort a whole audit for one key, and never report "0 healthy" because of it.

## 3. Watch for mixed timestamp units

Some old timeline entries are scored in nanoseconds or seconds, not milliseconds. A nanosecond score of 1.79e18 sorts above a millisecond score of 1.79e12, so an old entry looks newest.

- Do not trust score order or a `since` window on a key with mixed units.
- Read a wide window and sort by the entry's own `ts`, normalized to milliseconds (ns divided by 1e6, s times 1e3).
- LogMem's own logs are always milliseconds.

## 4. Fall back in this order

1. The LogMem tool (the server picks its backend).
2. The team's REST bridge, with the bridge's own token from your environment. The bridge allows only some commands: `PUBLISH` and `ZREMRANGEBYRANK` return HTTP 403 by design. A 403 is not an outage.
3. Direct Redis (`redis-cli`), only where your runbook allows it from your host. A direct read that succeeds is a full read, not a degraded one.

Unwrap REST replies: the bridge returns `{"result": ...}`. Read `.result`, not the whole body.

## 5. When nothing answers

If every path fails or times out:

1. Do not hammer it. Do not retry in a loop or keep changing the request shape.
2. Do not invent live state from an old snapshot or a previous run.
3. Report it once, when LogMem accepts writes again (or through your team's out-of-band channel):

```text
logmem_note { "where": "channel:agent-coordination", "kind": "problem", "summary": "Read path down: <which paths failed, since when>. No state was guessed.", "payload": { "degraded": true } }
```

A report with `payload.degraded: true` counts against the day's health check, by design. That is the honest result.

## Pitfalls

- An empty `HGETALL` on a JSON-string key reads like "the agent has no state". It is a type mismatch.
- A recovered bridge can still miss keys that were only written to a local fallback during the outage. Check the specific keys you need before you trust it.
- Tool success text such as "written" is not proof. Read the entry back.

## Verify

1. `logmem_connection` shows the expected backend and no `degraded: true`.
2. A read of the key you needed returns data with the command from the table in step 2.
3. If you reported an outage, `logmem_view { "ref": "channel:agent-coordination" }` shows exactly one report.
