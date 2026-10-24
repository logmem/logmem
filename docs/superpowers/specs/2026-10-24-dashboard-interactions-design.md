# Dashboard comments, reassignment, and item nudges

Michael approved this delivery after the dashboard status review on October 24.

Add one discussion panel for jobs, tasks, decisions, and plans. Comments use plain text and verified human authors.
Store an immutable discussion journal per target. Page through older entries. Limit each journal to 1000 entries and each comment to 2000 characters.
Show a retryable failure without discarding typed text. Changing spaces clears drafts and pending responses.
Comments never approve a decision, close a task, or settle a handoff.

Reassign jobs and open human tasks. Require a reason and the owner value the user saw.
Use an atomic comparison so concurrent owner changes or task progress never disappear.
Allow only space managers to reassign. Operator access retains its existing authority.
Human task recipients must have write access to the selected space. Agent owners must exist in that space.
Preserve task progress, job waits, and stages. Decision approval rights remain separate.
Reassignment does not transfer decision authority or rewrite historical handoffs.

Read the canonical coordination records from PR 120. Do not create another handoff index.
Show pending records ordered by deadline, with sender, recipient, source, creation time, deadline, and last nudge.
Expose coverage limits from the canonical index. An uninitialized index must not claim an empty backlog.
Nudges resolve recipients from stored records. They require request IDs and share a five minute cooldown per item.
Nudges do not settle items, change deadlines, or transfer ownership.

Every mutation records verified attribution and an immutable receipt. Retries reuse the request ID.
Commit record changes, journal entries, and receipts atomically. Deliver source log entries through the existing web store.
A delivery failure preserves the receipt. A retry finishes delivery without repeating the mutation.

Customer reads require selected space membership. Comments and nudges require write permission. Reassignment requires management permission.
Operator requests require their existing session and space allowlist. Every write requires same origin and an intent header.
User text remains escaped through lit-html. Keep secrets and client contact details out of source.

Keep Clerk work on PR 121. Deliver this work as a dependent branch without modifying that checkout.
Do not add calendar, Jev, roundtable settlement, or agent schedules in this pass.
