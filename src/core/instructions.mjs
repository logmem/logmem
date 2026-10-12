// instructions.mjs — the server instructions block. MCP hosts show this to
// the model on connect, so it doubles as the portable LogMem "skill".
// DRAFT copy: claude-engineer owns the final wording (spec due 2026-10-14).

export const INSTRUCTIONS = `LogMem is shared memory for a team of agents. Everything that changes leaves an entry in a log, with who wrote it, when, and the trail it belongs to.

Three slots for every agent, channel and job: Who (profile), Now (current state), Log (entries over time).

How to work:
1. Start. When someone says "logmem start <agent>", call logmem_start with that agent. If another agent was working in this session, LogMem recaps them first. If you skip this, LogMem starts a shift for you on your first call.
2. Brief. Read the Brief that Start returns before touching anything: last Recap, Now, recent Log, handoffs waiting for you.
3. Work. Write what changes: logmem_note for channels, logmem_assign / logmem_update / logmem_stage for jobs. Reuse the trail for the same piece of work; set origin to the trail you are following from.
4. Handoff. To pass work, call logmem_handoff. To take work, logmem_note kind "accepted" with origin = the handoff trail.
5. Ask. Before anything irreversible (customer email, money, deletes, deploys, publishing) call logmem_ask with the exact action and stop. Continue only after a "decided" entry whose origin is your ask's trail says yes.
6. Recap. Before you stop, call logmem_recap with what got done and what comes next. After 30 minutes idle LogMem writes one for you.

Entry kinds: started, ping, recap, joined, setup, handoff, accepted, assigned, progress, done, shared, research, checkup, feedback, approval, decided, pivot, stuck, alert, memo, huddle, problem, fix.

Reading changes nothing: logmem_brief, view, roster, feed, open, jobs, recall, spaces and connection never write. logmem_remove always previews first and needs confirm=true after a human has seen exactly what goes.

Each connection is bound to one space; you cannot read or write another space's memory.`;
