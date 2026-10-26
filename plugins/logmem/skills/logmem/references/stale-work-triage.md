# Stale-work triage and dispatch

Use when the operator asks to move stalled fleet work, not merely refresh status.

1. Read the live roster, non-done job index and existing audit ownership. Preserve the fleet's current coordinator and parent jobs rather than creating a parallel audit lane.
2. Read each candidate's exact Who, Now and log. Save batches to a local inventory so a timeout does not erase progress. Deduplicate IDs and reconcile enumerated counts in code.
3. Calculate age against tool-observed current time. Use the last substantive work event, not merely the newest timestamp. Starts, pings and monitoring recaps must not make abandoned work appear active. Inspect content because a checkup can contain real verification evidence.
4. Mark incomplete history or unreadable records unknown. An empty tail is not proof of 72 hours of silence. Expand the history window when needed before classifying age.
5. Classify candidates as agent-actionable, human-decision-gated, external dependency, deliberately parked, already delivered awaiting reconciliation, or unknown. Keep source timestamps, owner and blocker evidence with each row.
6. For actionable candidates, identify the smallest bounded next step and current owner's capacity. Send an owner-directed handoff with the existing job reference, acceptance criteria and original coordination trail. Use channel-scoped input requests if the parent owner must remain unchanged.
7. For human-gated or parked work, preserve the gate and existing ask. Do not generate repeat alerts unless the blocker materially changed or the operator requests escalation. Route missing ownership or access as a specific blocker.
8. Read back dispatched entries and any changed ownership. Distinguish requests posted, receivers accepted, work delivered and independently verified. Never collapse those into a single done claim.
9. Publish one concise linked triage result: inspected count, unknown count, actionable stale count, gated/parked count, dispatched steps and remaining owners. Attach the detailed index instead of flooding the coordination channel.

A bounded subagent can collect and classify this inventory read-only. The parent reviews its artifacts and performs shared-state transitions. Do not use a fresh child session as evidence of hosted 24-hour fleet coverage.
