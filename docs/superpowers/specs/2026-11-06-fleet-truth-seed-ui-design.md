# Fleet Truth Seed Briefing and Operator UI - Design

Date: 2026-11-06
Status: draft for review (design only, nothing seeded or built)
Job: fleet-truth-seed-ui (from agent:grok)
Space: `madez`
Builds on: `docs/superpowers/specs/2026-11-04-fleet-truth-board-design.md` and `docs/launch/fleet-truth-read.md` (both on branch `origin/feat/cloud-backplane`)

## Problem

The fleet truth board has a spec and a collector. It has no seed text and no way for an operator to read it in /app. The channel list in /app shows only the last entry per channel. The Activity page shows Log entries. Neither shows the Now payload. An operator cannot see the evidence tags.

This package defines two things as one unit. The seed briefing says what a supervised first run writes. The operator UI says how a person reads it.

## Goals

- A seed briefing that a supervised run can copy, check and write once.
- A read view where the operator sees the summary, the sections and the evidence tag on every Fact.
- A correction path that proposes and never hot-patches Now.
- Phone and desktop layouts that follow current app rules.

## Non-goals

- No new write path from the UI to Now. The scheduler stays the only writer after the seed.
- No seeding, merge, deploy or service call as part of this design.
- No secrets, tokens, keys or email addresses anywhere.

## Part 1: Seed briefing

The seed is a one-shot supervised run under the bootstrap exception in the board spec. A person watches it. The collector command is `node scripts/fleet-truth.mjs --space madez --slot manual --seed`. A dry run comes first.

### 1.1 Who fields for `channel:fleet-truth`

| Field | Value |
|---|---|
| purpose | One place that says what is true now for the madez fleet, with evidence on every claim. |
| cadence | 9 AM, 1 PM and 5 PM America/New_York, plus manual when Mikey asks. |
| schema | `fleet-truth/v1` |
| scheduler owner | `TBD: scheduler owner and host (placeholder until the operator picks one)` |
| write rule | Only the scheduled runner overwrites Now. Bootstrap seed is the one exception. |
| read rule | Read Now before you trust any coordination memo. |
| correction rule | Propose with a memo on this channel. Never edit Now. |
| hard rules | No secrets, tokens, keys or email. Do not wake lean or parked agents. The board reports state. It never spends or deletes. |

### 1.2 First Now

The summary line follows the spec:

`fleet-truth manual <ISO time> | P0=<plan> | top_blocker=<one line or none> | infra=<ok|degraded|unknown>`

Keep it under 200 characters. The payload uses these keys: `schema`, `refreshed_at`, `slot`, `runner`, `trail`, and the seven sections. Each section is `{ "items": [Fact] }`.

| Section | What the seed puts in it |
|---|---|
| clock | Show HN target, next CoS check slots, time of this seed. |
| lanes | P0, active and parked plans with owners. |
| launch | Open milestones, due jobs, merge and deploy state that matters now. |
| blockers | Waits on a person or an outside system. |
| infra | Bridge and token health labels (labels only, no values), key service codes. |
| agents | Core seats versus lean or parked seats. Unanswered handoff counts for core seats. |
| deltas | One Fact: "First seed. No earlier board to compare." |

Every row is a Fact:

| Field | Required | Rule |
|---|---|---|
| claim | yes | Plain English. One fact per row. |
| status | yes | `verified`, `reported`, `unknown` or `stale`. |
| observed_at | yes | ISO time of the reading. |
| source | yes | Job id, PR URL, probe path or feed trail. |
| verified_by | no | `agent:...` or `probe:...`. Omit when only reported. |

### 1.3 Evidence tags

| Tag | Use it when |
|---|---|
| verified | The seed run checked the primary source itself. |
| reported | Another agent or feed said it. The run did not re-check it. |
| unknown | An input was missing or a probe failed. |
| stale | It was known before and is now past its freshness window. |

A seed has no earlier board. So nothing starts as `stale`. If a person cannot check a claim during the seed, tag it `reported` or `unknown`. Never upgrade by guess.

### 1.4 Trail and pointer memo

- Trail for the seed: `fleetTruth-YYYYMMDD-manual` (for example `fleetTruth-20261106-manual`).
- Write one Log entry of kind `checkup` on `channel:fleet-truth` with that trail.
- After the seed, post one short memo on `channel:agent-coordination`. It names the trail, says "seed done, read channel:fleet-truth Now" and gives a one-line delta. It does not copy the board.

### 1.5 Dry-run checklist before a live seed

1. Run the collector with `--dry` and `--slot manual`. Confirm it prints a board and writes nothing.
2. Check `schema` equals `fleet-truth/v1` and `trail` matches `fleetTruth-YYYYMMDD-manual`.
3. Check each of the seven sections exists. An empty section needs one `unknown` Fact that says why.
4. Check every Fact has `claim`, `status`, `observed_at` and `source`.
5. Check every `status` is one of the four tags. Check no `verified` row lacks `verified_by` or a probe source.
6. Search the output for secrets, tokens, keys and email patterns. The count must be zero.
7. Check the summary line is under 200 characters.
8. Check the scheduler owner reads as a placeholder, not a guess.
9. Ask a person (logmem_ask) for approval of the exact live write. Act only on an `approve` verdict.
10. After the live seed, read it back in /app on phone and desktop widths. Confirm the acceptance list in section 7.

## Part 2: Operator UI

### 2.1 What exists today

- `#/channels/<id>` calls `pages.channels(id)`. It sets the Log filter to `channel:<id>` and shows the Activity page. It shows Log entries only.
- The Knowledge page lists channels as cards with the last entry and a "Read source entries" link.
- Phone nav has five tabs: Today, Work, Inbox, Team, More. The header has at most four controls. Cards show at most three actions. Extra actions go behind `moreMenu`. Touch targets are 44 px.
- Shared primitives: `head`, `panel`, `emptyState`, `kv`, `table`, `fresh`, `decision`, `idChip`, `moreMenu`, `btn`, `joinDot`, `agentName`, `ago`, `copy`, `renderView`.

### 2.2 How an operator opens it

- Desktop: Knowledge, then the `fleet-truth` channel card. Or paste `#/channels/fleet-truth`.
- Phone: More, then Knowledge, then the channel card. The coordination pointer memo also links to `#/channels/fleet-truth`.
- Under every approach the route `#/channels/fleet-truth` must work. It is the stable link agents and memos share.

### 2.3 Approaches

**A. Enhance the existing channel view.** When the channel id is `fleet-truth` and a Now payload with the right schema exists, `pages.channels` draws a board block above the normal Log list. Other channels stay as they are.

| Pro | Con |
|---|---|
| One route. Matches the read convention ("open that channel in the app"). | Needs the channel API to return Now. |
| Smallest change. No new nav entry. | The board shares a page with Log, so a long board pushes the Log down. |
| Works with the pointer memo link. | Special case for one channel id. |

**B. Dedicated `#/fleet-truth` page.** A new route and a new page.

| Pro | Con |
|---|---|
| Clean layout with no Log mixed in. | A second route to keep in step with the channel. |
| Room for filters and a full-width table. | Needs a nav slot. Phone nav is full. It would live under More. |
| | Splits "where do I look" in two. The spec says the channel is the home. |

**C. Overview card on Today plus the channel page.** Approach A, plus a compact card on Today.

| Pro | Con |
|---|---|
| Birds-eye on the first screen operators see. | Today already carries many cards. Adds noise. |
| Best for the "check first" habit. | Needs a second data read on Today. |
| | Higher risk of a stale card that disagrees with the channel. |

**Recommendation: A now, with C as a later step.** The spec makes the channel the home. A reuses the existing route and the existing pointer link. It needs the least new code and gives one place to look. Stage the Today card (C) only after A is live and operators ask for it. B adds a second home, which is the exact problem the board solves.

### 2.4 Page structure (approach A)

Board block, top to bottom:

1. Header line: title "Fleet truth", refresh age and slot label.
2. Summary line: the Now `summary` string, split into chips for P0, top blocker and infra.
3. Tag filter: four toggle buttons (verified, reported, unknown, stale) with counts. Default is all on.
4. Seven sections in fixed order: Clock, Lanes, Launch, Blockers, Infra, Agents, Deltas. Each section is a `panel` with a count and its Fact list.
5. A "Propose a correction" button in the page header area (or behind More on phone).
6. The normal channel Log list below the board, under a heading "Log".

Fact row:

```
[icon WORD]  claim text
             source: <copyable id chip>   verified by: <value>   seen <ago>
```

- Source and `verified_by` render as `idChip` style copy buttons. A URL source also renders as a link.
- Missing `verified_by` shows nothing for reported rows. For a `verified` row without it, show "verified by: not recorded" as a warning.

### 2.5 Status chips

Each chip is a word plus an icon. Colour is extra, never the only signal.

| Tag | Word | Icon (existing set) | Meaning shown in tooltip and screen reader text |
|---|---|---|---|
| verified | Verified | check | Checked at the source in this refresh. |
| reported | Reported | handoff | Carried from another agent. Not re-checked. |
| unknown | Unknown | alert | Input missing or probe failed. |
| stale | Stale | clock | Past its freshness window. Not re-checked. |

Build the chip with `decision(st, label)` or a small sibling in `ui.js` using the same `lm-decision` pattern. Do not reuse the "approved" or "failed" labels, since they mean other things. Icon names marked above are suggestions. Pick from the icons the app already ships and add none unless needed.

An unknown tag value renders as "Unknown tag: <value>" and counts under unknown. Never hide it.

### 2.6 Refresh age and slot label

- Read `refreshed_at` and `slot`. Show "Morning refresh, 3 h ago" using `ago()`.
- Slot words: morning, midday, closeout, manual.
- Use `fresh()` for the badge. Freshness window for the whole board is an open question (section 6). Until set, use 36 hours, the collector's `FRESHNESS_MS`, as the default and label it "default window".
- If the board is past the window, show a `stale` banner at the top: "This board is older than the expected refresh. Treat every row as stale." Do not rewrite row tags. The collector owns tags.

### 2.7 Empty state before the seed

Use `emptyState`:

- Title: "No fleet truth board yet."
- Body: "The first board appears after a supervised seed. Until then, coordination memos are not a source of truth. Ask the operator who owns the seed."
- Below it, the normal Log list still shows. No error styling. This is not a failure.

If Now exists but the schema is not `fleet-truth/v1`, show: "This board uses a schema this app does not read (<value>). Showing raw entries below." Fall back to the Log list.

### 2.8 Correction-memo affordance

- Button label: "Propose a correction".
- It opens a small form (the existing sheet or details pattern): which claim (prefilled from the row, chosen by a "Propose fix" row action behind `moreMenu`), what is wrong, the evidence, and a source.
- Submit writes a `memo` entry on `channel:fleet-truth`. It does not touch Now.
- Text above the form: "This sends a proposal. The next scheduled run re-checks it. Nothing on the board changes now."
- The form blocks submit if the text matches secret, token, key or email patterns. It shows why.
- Corrections appear in the Log list below the board. They carry a "Proposal" label. v0 has no auto-merge, so the label stays until a person or later collector change applies it.
- If the app has no write route for memos yet, the button copies a ready-made memo text with `copy()`. This is the fallback. See open question 5.

### 2.9 Layouts

Desktop wireframe (width 1024 and up):

```
+----------------------------------------------------------------------+
| Fleet truth                         Morning refresh, 3 h ago  [Fresh] |
|                                     [Refresh view]  [Propose a fix]   |
| P0: launch-hn | Top blocker: waits on approval | Infra: degraded     |
| Show: [Verified 12] [Reported 5] [Unknown 2] [Stale 1]               |
+----------------------------------------------------------------------+
| Clock (3)                          | Lanes (4)                        |
|  [check Verified] Show HN target.. |  [check Verified] P0 is ...      |
|     source: [..a1b2c3] by: probe.. |     source: [..d4e5f6]           |
|  ...                               |  ...                             |
+------------------------------------+----------------------------------+
| Launch (3)                         | Blockers (2)                     |
+------------------------------------+----------------------------------+
| Infra (5)                          | Agents (6)                       |
+------------------------------------+----------------------------------+
| Deltas (1)                                                            |
+----------------------------------------------------------------------+
| Log                                                                   |
|  checkup  fleetTruth-20261106-manual  ...                             |
+----------------------------------------------------------------------+
```

Phone wireframe (width 639 and below, one column):

```
+------------------------------+
| < Fleet truth       [?] [...] |   header: back, help, more (max 4)
+------------------------------+
| Morning refresh, 3 h ago     |
| [check Fresh]                |
| P0: launch-hn                |
| Blocker: waits on approval   |
| Infra: degraded              |
| [Verified 12] [Reported 5]   |
| [Unknown 2]   [Stale 1]      |
+------------------------------+
| v Clock (3)                  |   details, open by default for
|  [check Verified]            |   Blockers and Infra, closed
|  Show HN target is ...       |   for the rest
|  source [..a1b2c3]           |
|  seen 3 h ago                |
|  [Copy source] [More v]      |   max 3 actions, rest in More
+------------------------------+
| > Lanes (4)                  |
| > Launch (3)                 |
| > Blockers (2)               |
| > Infra (5)                  |
| > Agents (6)                 |
| > Deltas (1)                 |
+------------------------------+
| Log (collapsed list)         |
+------------------------------+
| Today  Work  Inbox Team More |
+------------------------------+
```

Phone rules honoured: five tabs unchanged, header holds at most four controls, each Fact card shows at most three actions (Copy source, Copy verified by, More), "Propose fix" sits behind More, all targets 44 px high.

### 2.10 Accessibility

- Contrast: chip text and borders meet WCAG 2.1 AA (4.5:1 text, 3:1 icon and border) in light and dark themes. Use existing theme tokens, not new hex values. Check each tag in both themes.
- Colour is never the only signal. Every chip has a word and an icon.
- Keyboard: tag filters are `button` elements with `aria-pressed`. Sections are `details` with `summary`. Copy chips are buttons. Tab order follows reading order. Focus ring is visible. The correction form traps no focus and closes with Escape.
- Screen reader: each chip has text like "Status: Verified. Checked at the source in this refresh." Hide the decorative icon with `aria-hidden`. Each section has a heading and its count. The refresh line is a `role="status"` text updated on view refresh. The stale banner uses `role="alert"` only on first render.
- Each Fact row reads in one order: status, claim, source, verified by, age.
- Do not announce every filter change. Announce the new visible count once.
- Reduced motion: no animation is required.

## Part 3: Component list

| Need | Reuse | New |
|---|---|---|
| Page frame | `renderView`, `head`, `panel` | none |
| Empty state | `emptyState` | none |
| Status chip | `decision` pattern, `icon` | `evidenceChip(tag)` in `ui.js` (small) |
| Freshness badge | `fresh`, `ago` | none |
| Copy source and verified_by | `idChip`, `copy` | none |
| Fact row | `kv`, `joinDot` | `factRow(fact)` in `cards.js` |
| Section block | `panel`, `details` | `truthSection(name, items)` |
| Tag filter | `lmx-tabsbar` toggle pattern | none |
| Row extra actions | `moreMenu`, `btn` | none |
| Correction form | existing sheet or details pattern | `correctionForm(claim)` |
| Board block | none | `drawFleetTruth(now)` called from `pages.channels` |
| Data read | existing `api('channels')` | read of channel Now (open question 4) |

## Part 4: Data contract the UI reads

The UI reads `channel:fleet-truth` Now. Field names follow the board spec. Defaults apply when a field is missing. The UI never throws on missing data.

| Field | Default when missing |
|---|---|
| `schema` | Treat as unknown schema. Show the fallback message in 2.7. |
| `refreshed_at` | Show "Refresh time not recorded". Mark the board as stale. |
| `slot` | Show no slot label. |
| `runner` | Show "runner not recorded". |
| `trail` | Hide the trail copy button. |
| `summary` (entry summary) | Build a line from section data. Show "Summary not recorded" if that fails. |
| each section | Missing section shows "Not reported in this refresh." and counts as zero. |
| `section.items` | Empty list. Same message. |
| `fact.claim` | Show "Claim text missing". |
| `fact.status` | Treat as `unknown`. |
| `fact.observed_at` | Show "Time not recorded". |
| `fact.source` | Show "Source not recorded" in a warning style. |
| `fact.verified_by` | Omit. Warn only when status is `verified`. |

Rules: the UI never changes a row's status. It never hides a row. It escapes all text (lit-html does this). It does not follow a `source` URL unless it starts with `https://`. It must not render any value that looks like a secret. If the collector let one through, the UI shows "Redacted by viewer" and notes it in the console for the operator.

## Part 5: Edge cases

- Board older than the window: show the stale banner. Keep row tags as written.
- Collector failed one section: that section holds `unknown` Facts. Show them normally.
- Two refreshes close together: show the latest only. The Log holds history.
- Very long claim: wrap, do not truncate. Source chips stay short.
- Offline or paused data: reuse the existing `LIVE_LABEL` states.

## Part 6: Open questions

1. Scheduler host and agent id. CoS seat, ops-center or a dedicated runner. Needed to fill the Who placeholder and to wire the timer.
2. Probe allowlist for infra. Which bridge health path and which HTTP checks may the runner call.
3. Freshness windows. One window per section or one for the board. When does `reported` turn `stale`. The collector default is 36 hours.
4. Does `api('channels')` return the Now payload, or does the UI need a new read? The current channel card shows only the last entry.
5. Is there an app write route for a `memo` entry, or should v0 use the copy-text fallback for corrections?
6. Should the Today card (approach C) ship in the same release or wait for operator feedback?
7. Who approves the live seed: Mikey only, or any core agent through logmem_ask?

### Verified answers (claude-code, Nov 6)
- Open question about the Now payload: checked in `src/http/view.mjs:635-648`. The `channels` view returns the channel list, the last entry of each, and up to 100 log entries of the picked channel. It does not return the channel's Who or Now. So approach A needs one small backend addition: a read of the channel Now and Who in that view (read-only, same auth). This belongs in Layer 1 of the layered plan and needs an owner (opencode or grok).
- The seed itself stays held. Grok keeps the seed run. Mikey approves it separately.

## Part 7: Acceptance checklist

Seed:

- [ ] Dry run printed a full board and wrote nothing.
- [ ] Who has purpose, cadence, schema, scheduler placeholder and hard rules.
- [ ] Now has summary line and all seven sections.
- [ ] Every Fact has claim, status, observed_at and source.
- [ ] Trail is `fleetTruth-YYYYMMDD-manual` and the Log has one `checkup` with it.
- [ ] Secret, token, key and email scan found zero matches.
- [ ] A person approved the live write.
- [ ] One pointer memo exists on `channel:agent-coordination`.

UI:

- [ ] `#/channels/fleet-truth` opens the board from Knowledge on phone and desktop.
- [ ] Empty state shows before the seed and does not look like an error.
- [ ] Summary line and seven sections show in fixed order.
- [ ] All four tags show a word and an icon in light and dark themes.
- [ ] Source and verified_by are visible and copyable.
- [ ] Refresh age and slot label show. Stale banner shows past the window.
- [ ] Missing fields use the defaults in Part 4 with no console error.
- [ ] "Propose a correction" never writes to Now and warns about secrets.
- [ ] Phone: five tabs, header at most four controls, at most three actions per card, 44 px targets.
- [ ] Keyboard only: every control reachable, visible focus, Escape closes the form.
- [ ] Screen reader: chips, sections and refresh line read in a sensible order.
- [ ] Contrast meets AA for text and icons.
- [ ] Other channels render exactly as before.
