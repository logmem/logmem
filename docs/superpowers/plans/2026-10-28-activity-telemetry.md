# Activity telemetry and assistant widget

Implement the operator's histogram and command-widget designs in the HTML app.
This change stacks on PR 175. Review order: PR 172, PR 175, then this branch.

## Timeline

Use 48 equal bins across the actual loaded time interval.
Teal height shows loaded entry counts. Amber marks recorded stuck events.
Peak controls target real event timestamps within the busiest matching bins.
Do not infer a mirror mismatch from prose or imply complete 24-hour coverage.
Keep the native range input for keyboard, touch and screen-reader control.
Combine the timestamp and five cumulative event counts in one compact bar.
Return to the latest loaded entry without claiming a real-time runner feed.
Reject blank, nonpositive and future timestamps.

## Assistant

Show Inbox, Knowledge, Health and Activity as source-aware rows.
Label queue counts as loaded-page counts and mirror counts as audit-window counts.
Unknown counts invite measurement. Failed reads show Unavailable instead of zero.
Record observation time and isolate snapshots by space.
Clear snapshots when the account context resets.
An explicit refresh reads four existing endpoints. Do not add background polling.

Show data transport status separately from agent execution.
No local bridge heartbeat exists, so execution remains unverified.
Inspect configured account or space grants in an inline panel without navigation.
Configured grants do not prove that client tunnels are online.
Keep management in the existing authorized page, opened in a separate tab.
Do not add connection mutations or pretend an access toggle controls a process.
Key the inspector by account and space. Ignore responses after context changes.

## Verification

All 990 repository tests pass.
All 24 desktop and phone browser cases pass.
Checks cover actual-event jumps, keyboard controls, four themes and snapshot refresh.
Checks also cover failed sources, account authentication, no copy mutations and space isolation.
An early fixture omitted its space and bypassed another test route. The corrected fixtures pass.
No backend schema, authorization or deployment changed.
