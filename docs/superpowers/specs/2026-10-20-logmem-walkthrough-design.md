# Walkthroughs: the admin writer and the consumer player

Date: 2026-10-20. Job: `walkthrough-dashboard-20261020` (plan `launch`).
Design: grok's huddle `huddleWalkthroughProduct-20261020`. Decision: Mikey approved option A on
ask `approvalWalkthroughDashboard20261020-1792504401182-f3e0eaeb5e9effbae699e3d3`.

## What it is

A walkthrough guides one person through a task, one step at a time. It is a task for a person
(the blockers model, `src/core/blockers.mjs`), so it sits on a job and the job waits on it.

- **Admin writer.** A signed-in person writes it on a job page in `/app`, at `#/write/<job>`.
  The writer sets a title, the person it is for (`human:<id>`), at most 7 steps, a "done when" line
  and a starting reply. It can be previewed. It can be edited until the first step is ticked.
- **Consumer player.** `#/walk/<space>/<trail>`, with no admin rail or tabs. It shows one step at a time:
  the count ("Step 2 of 5"), where to go, what to do, more detail, a command to copy, and what the
  person should see. The step rail is the onboarding rail. Progress comes back to the first step
  not yet ticked. The last screen sends the reply, or says why the person can't finish.

## Steps

Each step has `title` (what to do, required), and optional `go` (where to go), `detail`, `cmd`
and `see` (what you should see). Agents can use `go` and `see` in `logmem_handoff` walkthroughs too.
A `go` value that is an http(s) URL becomes a link that opens in a new tab with
`rel="noopener noreferrer"`. Any other value stays plain text.

## Writes

- **One new admin save:** `POST /api/tasks { action: "write", job, to?, summary, walkthrough, trail? }`.
  New: a handoff entry by the writer on the job log, the task record, and the job linked to it
  (`blocked_on` a task). With `trail`: replace the walkthrough. Refused once a step is ticked, and
  refused for anyone but the writer.
- **One consumer tick write:** the existing `step` action. The last screen uses the existing `done`
  (with the reply as its note) or `cant_do` (with the reason).
- **Read for the player:** `GET /api/tasks?space=…&trail=…` returns one task, open or closed, to the
  person it is for or who wrote it.

Same gates as every task write: a signed-in admin session, `X-LogMem-Intent: blockers`, same origin,
and a space the web app shows.

## No secret values

The save refuses text that looks like a secret value: private key blocks, `sk-`, `ghp_`, `npm_`,
`xox?-` and `AKIA` keys, `Bearer …`, `NAME=value` for token, password, secret or api key, and long
mixed letter and digit blobs. Hex strings such as commit hashes are allowed. The message says to name
where the value lives instead.

## Out of scope for v1

- The fleet checklist, and attaching the old Preview or price checklists.
- People without the admin sign-in. The player uses the web app's session today. Opening it to
  other people comes with accounts (Clerk).
- Automatic checks of a step. Ticks are manual.
