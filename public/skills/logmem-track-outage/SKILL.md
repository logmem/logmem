---
name: logmem-track-outage
description: Use this instead of the ACMI track, cron-track and outage-emit skills (ACMI). Run a scheduled tracker that watches a job or lane in LogMem and writes only when something changed, stays silent otherwise, and writes one honest outage report when it cannot read.
---

# LogMem tracking and outages

A tracker runs on a schedule (a cron or a loop) and watches one job or lane. It must not flood the log. It writes only when the state changed, stays silent when nothing changed, and reports an outage once when it cannot read.

## When this skill applies

- You run a scheduled check on a job, a lane or an agent.
- You are writing or fixing a tracker that posted the same note again and again, or that went silent during an outage.

## 1. Read the state

Use LogMem reads. They handle key types and timestamp units for you:

```text
logmem_open { "job": "<job id>", "limit": 20 }
logmem_feed { "refs": ["channel:agent-coordination", "job:<job id>"], "since": "2h" }
```

If a read fails, use **logmem-read-path-recovery** before you decide anything.

## 2. Keep the tracker's own state small

Store what you saw last time in the job's Now, or in a local state file:

- `last_check_ts`: when you last checked (milliseconds)
- `last_stage`: the job's stage at that time
- `last_entry_ts`: the newest entry you had seen

```text
logmem_status { "now": { "tracking": "job:<job id>", "last_check_ts": <ms> } }
```

## 3. Decide: change, no change, or outage

| What you saw | Do |
|---|---|
| The stage changed, or a new entry is newer than `last_entry_ts` | Write **one** entry about the change. Update your state |
| Nothing changed | Write nothing. Update `last_check_ts` only |
| Every read path failed | Write **one** outage report (step 4). Do not treat the empty read as "nothing changed" |

Missing data is not a change. A field that is absent because a read failed must never trigger a "status changed" note.

## 4. Write

A change:

```text
logmem_note { "where": "job:<job id>", "kind": "checkup", "origin": "<trail of the entry that changed>", "summary": "<job id> moved to <stage>: <one line why>." }
```

An outage, once per outage, not once per run:

```text
logmem_note { "where": "channel:agent-coordination", "kind": "problem", "summary": "Tracker for <job id> cannot read since <time>. No state was guessed.", "payload": { "degraded": true } }
```

Then stay silent until reads work again. When they do, write one "recovered" note.

## 5. Rules for trackers

- Never ping agents or people from a track-only run. Write the entry; the team reads it.
- Never post the same note twice. Compare with your state first.
- Keep the schedule modest. A check every few minutes on a job that changes daily wastes writes and money.
- Never put a secret in a state file or an entry.

## Verify

1. Run the tracker twice with no change: the second run writes nothing.
2. Change the job's stage: the next run writes exactly one entry.
3. Point it at a backend that is down: it writes exactly one outage report, then stays silent.
