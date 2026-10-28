# Coordination repair

Repair derived indexes without deleting source history.

## Verify before changing live state

Record the exact source revision and selected LogMem space.
Use approved environment configuration. Never put credentials in commands or receipts.
Keep the runner on the selected durable backend.

Run the history scan without writes first:

```sh
node scripts/coord-backfill.mjs --space madez --dry
```

Inspect status, counts and warnings. Partial coverage is a failed completeness check.
Unreadable legacy identifiers and ambiguous directed replies require source verification.
Resolve those cases before claiming complete coverage.
The scan reads registered agent, job and channel histories.
It verifies recipient-authored responses before settling historical requests.

After review and the applicable live-state approval, run the same revision without `--dry`.
Read the coverage hash and compare queue counts against the scan receipt.
Keep a dry-run receipt and the apply receipt together.
A changing source revision keeps coverage partial. Rerun a stable verification pass.

## Resolve stale coordination

Open Inbox, then Comments and actions for the indexed request.
A permitted manager can expand Resolve a stale request and give a concrete reason.
The change records the manager, reason, time and source trail.
It removes the obligation from both pending indexes.
It does not complete linked jobs or impersonate the recipient.
Historical source-only rows need verified indexing before this action is available.

## Diagnose compatibility copies

The missing-copy metric describes log rows in one audit window.
It does not prove loss of the original LogMem entries.
Record the window, writer policy, bounded mismatch classifications and retry depth.
Treat explicit mirror-off entries separately from required copies.
Treat missing policy metadata as unknown evidence.
Do not enable mirroring or replay entries just to make the count zero.
Run the existing daily check with `--dry` to inspect current evidence before any repair.

## Verify scheduled work

Receipt slots do not schedule agents.
Use the existing scheduler audit to record host, command, enabled schedule and last successful receipt.
Include next run and failover evidence.
Do not report an agent as running from its roster or a saved status alone.
