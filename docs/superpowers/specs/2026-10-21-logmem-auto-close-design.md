# Auto-close reconciler

Status: approved by Mikey on 2026-10-21 ("looks right"). Track: leaks and cracks (D).
Owner: claude-code. Reviewer: codex. Job: `auto-close-reconciler`.

## Problem

A job changes stage only when someone calls `logmem_stage`. Work often
finishes elsewhere: a PR merges, an agent writes "Done:" in an entry, a
person finishes a task. The job then stays active, and the board stops being
a source of truth for operators.

## Rule

LogMem closes a job itself when the evidence is clear, writes why, asks the
owner to acknowledge, and only a person can reopen it.

## Evidence (the only things that close a job)

| Signal | Closes | Only suggests ("looks done?") |
|---|---|---|
| `pr` | A merged PR whose body says `Closes job: <id>`, with no entry on the job more than an hour after the merge | A PR in the job's `evidence` field; a closing PR with work after the merge; a plain `Job: <id>` mention |
| `parts` | A milestone whose child jobs are all done (at least one), or a job blocked only on a person's task that is now done | |
| `owner` | | The job's newest entry is a Done by its owner |

The first dry run on madez (Oct 21) set these rules. Owner Done entries are
often one finished step, not the job (4 of 5 hits). One evidence PR was the
PR a job builds on (launch-privacy-terms-cookie-banner, PR #53). Every
merged PR from now on that finishes a job says `Closes job: <id>`.

Skipped: parked jobs, jobs a person reopened (Now `auto_close: "off"`), and
jobs with a reopen ask waiting. If GitHub can't be read, the PR signal is off
for that run; nothing closes on a guess.

## On close

1. `logmem_stage done` as `agent:logmem-reconciler`, with the evidence in the note.
2. Now `auto_closed: { at, prev_stage, signal, evidence }`.
3. A handoff to the owner: accept to acknowledge, or ask
   "Reopen <job>?" with `logmem_ask` on the job.

## Reopen

The owner's ask blocks the job, so it is not closed again while it waits. A
person answers. Approved (verified decisions only, read from the owner's
Brief): the next run restores the old stage and sets `auto_close: "off"`, so
that job is never auto-closed again. Rejected: the job stays done.

## Stale

An overdue job with no entry for 48 hours is reported as stale. The board
badge and Needs you row come in a follow-up PR.

## Running it

- `GET /api/cron/reconcile`: Vercel Cron daily at 13:30 UTC (a sub-daily
  schedule can fail deploys on some plans), or a signed-in admin, who always
  gets the dry report.
- `node scripts/reconcile.mjs --space=madez [--apply]`: the fleet scheduler
  every 15 minutes.
- Dry by default. It closes only with `LOGMEM_RECONCILE_MODE=on`. The first
  run is a dry list Mikey approves before mode goes on.
- Env: `LOGMEM_RECONCILE_SPACES` (default `madez`), `LOGMEM_GITHUB_REPO`
  (default `madezmedia/logmem`), `LOGMEM_GITHUB_TOKEN` (optional, read-only).

## Tests

`test/reconcile.test.mjs`: each signal, mention vs close, parked and person
task skips, GitHub down, stale, apply with ack, second run unchanged, reopen
held then approved then never auto-closed, an agent cannot fake the approval,
dry run writes nothing, cron and admin auth.
