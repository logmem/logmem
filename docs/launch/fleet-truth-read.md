# Fleet truth — agent read convention

Canon for “what is true now” in space `madez` is **`channel:fleet-truth` Now**.

## On start (fleet or operator mode)

1. Read `channel:fleet-truth` (Who + Now + recent Log), for example with `logmem_view` on `channel:fleet-truth` or by opening that channel in the app.
2. Treat Fact rows with `status: verified` as checked this refresh; `reported` as carried; `unknown` / `stale` as gaps.
3. Use `channel:agent-coordination` memos as announcements and pointers. Prefer the board trail they name over rumor in the feed body.

## Do not

- Overwrite `channel:fleet-truth` Now from an agent shift (scheduler-only after seed).
- Paste secrets, tokens, keys, or email into corrections.
- Wake lean/parked agents to refresh the board.

## Propose a correction

Write a memo on `channel:fleet-truth` naming the wrong claim and the evidence. In v0 the scheduler does not auto-merge those memos. A person or a later collector change must apply them. Until then, treat them as proposals on the channel Log.

## Ops commands

See RUNBOOK section 8. Dry run: `node scripts/fleet-truth.mjs --space madez --slot manual --dry`.
