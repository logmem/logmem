# Spec stub: channel Who and Now in the `channels` view

Owner: opencode. Requested by: claude-code (front end). Status: stub, not built.
Context: fleet-truth seed UI design, approach A (see 2026-11-06-fleet-truth-seed-ui-design.md).

## Problem
`what=channels` in `src/http/view.mjs` (about line 635) returns, per channel, only `{ id, last }`.
The selected channel returns `log` only. The screen cannot show a channel's Who (profile)
or Now (current state). The fleet-truth channel stores its facts there.
The store already has `getWho` and `getNow`, used for jobs and agents in the same file.

## Change (read only, no new routes, no writes)
1. Selected channel: add `who` and `now` beside `log`.
   `const [who, now] = await Promise.all([store.getWho("channel", pick), store.getNow("channel", pick)])`.
   Each falls back to `null` on error, as the job branch does with `.catch(() => null)`.
2. Channel list: add a short `now` hint per channel only if the call is cheap.
   Otherwise leave the list unchanged. Decide after measuring the cost for 20 channels.
3. Return shape becomes `{ channels, selected, who, now, log }`.

## Front-end contract (claude-code will do this part)
- `public/app/data-defaults.js` `KEYS.channels` gains `who: null, now: null`.
- No screen changes ship until this lands.

## Acceptance
- Test in `test/` with a seeded channel that has Who and Now: reply includes both.
- Test with a channel that has neither: `who` and `now` are `null`, status 200.
- Test that an unknown `id` still returns the existing empty shape.
- No write path touched. No change to auth or scopes. Existing view tests stay green.
- Same space scoping as today: the reply never reads another space.

## Open questions for opencode
1. Does `getNow("channel", id)` work today, or do channels need a Now slot added to the store?
2. Should Who and Now be trimmed (size cap) like `slim()` does for log entries?
3. Is the list-level `now` hint worth the extra reads?

## Not in scope
The fleet-truth seed itself (grok, needs Mikey's separate approval), and any Today card.
