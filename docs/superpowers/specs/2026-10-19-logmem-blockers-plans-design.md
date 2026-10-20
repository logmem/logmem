# LogMem Blockers and Plans — design

Status: APPROVED by Mikey, 2026-10-19. Owner: claude-code.

## Goal

Move the launch tracker into LogMem, and make it a product feature for every LogMem user. Agents hand a person the work only that person can do, with a step-by-step walkthrough. The person works through it in the web app. A plan view shows jobs grouped into tracks and milestones.

## Decisions (Mikey, 2026-10-19)

| Question | Decision |
|---|---|
| Who sees it | Mikey and the fleet in `/app`, and the same feature for every LogMem user |
| Walkthrough progress | Saved in LogMem, so agents see it and it follows the person across devices |
| What a blocker is | A handoff to a person (`to: "human:<id>"`) with an optional walkthrough |
| The old tracker page | Retired with a pointer, after its items move into LogMem |

## Blockers

- **Creating one:** `logmem_handoff` with `to: "human:<id>"`.
  - `where` (a job or channel) is required.
  - `walkthrough` is optional: `{ steps: [{ title, detail?, cmd? }], time?, place?, done_when?, reply?, due? }`, with at most 20 steps and capped text lengths.
- **Storage:**
  - The handoff entry goes on the work's log, with the walkthrough in its payload.
  - The record lives at `lm:{space}:blocker:{trail}`, with `steps_done` and `done`.
  - Open trails are in `lm:{space}:blocker:open`.
- **Who ticks steps:** only the web app, signed in as a person, can tick a step or mark the blocker done (`/api/blockers`). Writes need `X-LogMem-Intent: blockers` and the same origin. Each tick and the Done write an entry by that person on the work's log.
- **Mirroring:** writes from the web app go through the mirrored store, so in a mirrored space each person entry has its ACMI copy. `/api/decide` now uses the same store, which fixes decisions that previously counted as mirror mismatches.
- **The agent's view:** the Brief has `person_blockers`, with progress such as "3/7".
- **The dogfood check** skips handoffs to people. A slow person must not fail the agents' health.

## Plans

- **Plan jobs:** a job joins a plan through `logmem_assign` details: `plan`, `track`, `gate`, `due`, `desc` and `evidence`.
- **Milestones:** a milestone is a job with `{ plan, milestone: true, date, criteria }`.
- **The view:** `/api/view?what=plan&id=<plan>` returns the plans, milestones sorted by date, the tracks with their items, and percent done (done jobs over all jobs).

## Web app

- **Blockers page:** each open blocker as a card, with its steps as tick boxes, copy buttons for commands and for the reply message, "Done when", a note, and Mark done.
- **Plan page:** a plan picker, the milestone rail, the tracks with their items and percentages, and a link to Blockers.

## Moving the tracker

- The board's tracks become jobs in plan `launch`, and its gates become milestones.
- Its "Waiting on you" items become handoffs to `human:mikey`, with their walkthroughs.
- The board page then gets one last version that points to `logmem.si/app → Plan`.
