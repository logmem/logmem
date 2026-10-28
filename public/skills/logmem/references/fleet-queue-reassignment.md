# Absorbing a stopped agent's queue

Use when the operator reports an agent is rate limited, out of credit or otherwise stopped, and asks for its work to be picked up or reassigned. The goal: no job ends up unowned, and no finished step is redone.

## 1. Enumerate the queue with owners

`logmem_jobs` returns a flat array of job-id strings — no owner, stage, plan or track. Get owners by opening each job read-only and reading `now.owner`:

```js
const ids = (await call("logmem_jobs")).jobs || [];
for (const id of ids) {
  const o = await call("logmem_open", { job: id, limit: 1 });
  rows.push({ id, owner: o?.now?.owner || null, stage: o?.now?.stage || "?" });
}
```

One call per job, so a few hundred jobs takes a couple of minutes. Append rows to a workspace file as you go rather than holding the whole result in one message. Then tally per owner and report that tally before moving anything — it is the number the operator actually asked about, and it shows whether the load is one agent's backlog or fleet-wide.

## 2. Route by capability, not round-robin

Assign each job to the agent whose existing lane already covers it: reviews to the reviewer, bridge and migration work to whoever was executing that lane, security and rotation to infra, coordination jobs to the coordinator. Round-robin spreads thirty jobs across eight agents and produces thirty jobs nobody owns properly.

Keep the critical path in the requesting lead's own lane instead of delegating it.

## 3. Move ownership with a job handoff

`logmem_handoff { to: "agent:<id>", where: "job:<id>", summary: "..." }` changes the job's Now owner to the receiver. There is no bulk operation; one handoff per job.

Every summary carries three things: the reason, the job id, and the continuity instruction — *continue from the job's existing Now and evidence, do not redo completed steps, change scope only with the lead*. Without the third, receivers re-run finished work.

## 4. Pitfalls

- **Handoffs addressed to your own identity land in your inbox.** Reassigning jobs to yourself creates one unaccepted handoff to you per job. Accept them in the same session, or your own Brief shows a backlog you created.
- **A bulk reassignment spikes the fleet's unanswered-handoff count.** Every receiver must accept or decline before the daily health check clears. Announce the count and the reason, or the spike reads as fleet-wide neglect instead of one deliberate move.
- **Retry a failed handoff once.** A single handoff can return an internal error while its neighbours succeed. Retry that one job; do not re-run the whole batch.
- **The summary is capped at 1000 characters**, like any entry. Keep it to the reason plus the continuity line.
- **Verify after moving.** Re-read each reassigned job and confirm `now.owner` is the new agent, and re-count the source agent's remaining jobs. A handoff that printed no error is not proof the owner changed.
- **A straggler can survive the batch.** Re-count the source agent's queue at the end; a job can still show the old owner and need a second handoff.

## 5. Announce, then record

Post one coordination memo: the source agent, the total moved, the per-owner split, and the instruction to accept or decline. If the operator stated the cause (a rate limit, an outage), record that as a ruling memo citing them — see the entry rules in SKILL.md.
