# Dashboard foundation results

Codex implemented phase A of the approved dashboard design.
Draft PR: https://github.com/madezmedia/logmem/pull/119.

Today presents personal requests, team waits, source updates, and priorities.
Work defaults to a prioritized list and stores its board preference per space.
Activity groups source records. Settings holds administration links.
Agent reports remain separate from verified runtime state.

Decision cards show the exact action and require reasons for change requests.
The browser binds submissions to the reviewed action digest.
Receipts distinguish saved approval from verified completion.
A space change clears the previous space's receipt.

Independent review found two important defects.
Required decision reads silently hid pending work on backend failures.
The sample session also authorized APIs outside its isolated store.
Regression tests reproduced both defects before the fixes.
Required reads now fail visibly. The sample server restricts API routes.
It also clears inherited customer backend settings.

Final CI passed 791 tests. The schema was current. All 30 conformance cases passed.

Browser checks covered Today, Work, Settings, Activity, decisions, and space changes.
Widths of 390, 768, and 1280 pixels showed no horizontal overflow.
Synthetic approval left the job active. Deferral kept the request open.

## Rulings I made

- Reuse the isolated checkout. A wrong location risks unrelated edits. The shared checkout remains untouched.
- Execute the approved plan without another approval prompt. A wrong scope risks unwanted work. This change covers phase A only.
- Preserve Claude's pending-index work and Ops schedule ownership. Missing integration leaves those capabilities unavailable here.
- Reject late responses after space changes. Incorrect guards risk discarding a useful read. Requests refresh in the selected space.
- Group updates and flag invalid or future times. An incorrect filter risks hiding records. Raw events remain available.
- Use a disposable sample person session on the loopback server. Incorrect isolation risks real writes. Restricted routes use the memory store.
- Keep the established decision API response status of 201. Changing it risks client incompatibility.
- Add optional action digests for compatibility. Old clients retain their protocol. The dashboard always sends its reviewed digest.
- Propagate required read failures. A partial outage blocks the view until storage recovers. It cannot present zero pending requests.
- Restrict sample APIs and clear customer settings. Unsupported sample administration pages return an unavailable message.

## Review follow-up

Codex restored Sign out in Settings after the next user continuation.
The phone browser check found zero visible controls before the fix and one after it.
Fresh local CI passed 791 tests, schema validation, and 30 conformance cases.
GitHub Actions could not start because account payments failed.
Vercel built the previous preview successfully.

## Remaining integrations

Claude retains the shared pending indexes.
Ops retains schedules and runner mapping.
Run controls need verified permissions, budgets, schedules, and execution evidence.
Release status is tracked in PR #119.
