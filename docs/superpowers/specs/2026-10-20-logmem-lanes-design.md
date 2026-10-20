# LogMem lanes: a live multi-lane status board

Status: APPROVED by Mikey, 2026-10-20. Owner: claude-code.
Extends the work taxonomy (`2026-10-19-logmem-work-taxonomy-design.md`) and the live app (`2026-10-19-logmem-live-app-design.md`).

## 1. Problem

The fleet runs on "One Lane" rulings: LogMem launch is the P0, Entry is parked, OpenACP x Super Bus is unparked. These rulings live only in chat and in memos. Grok proposed a `lane-driver` job whose Now names the active lane. That is a second copy of state, and it goes stale.

## 2. Decisions (Mikey, 2026-10-20)

| Question | Decision |
|---|---|
| What a lane is | A plan with a status |
| How strict One Lane is | Exactly one P0 lane. Other lanes may be active at lower priority, or parked |

## 3. Model

- A plan record gets `lane: { status, why?, until?, owner?, set_by, set_at }`, where `status` is `p0`, `active` or `parked`.
- Making a plan P0 moves the old P0 lane to `active`, with the reason "<title> became the P0 lane".
- Parking a lane needs `why`. `until` is optional, such as "G-12" or "after Show HN".
- A job can park inside a lane: `logmem_stage blocked` with `blocked_on: { type, note, parked: true, until? }`. A parked job waits on purpose. It shows under Parked, never under Blocked.
- Every lane change writes one entry on `channel:lanes`, by the agent or the person who made it.

## 4. Tools and API

- `logmem_plan { action: "lane", plan, status, why?, until?, owner? }`. Agents use it to record a person's ruling.
- `POST /api/lane { space, plan, status, why?, until? }`. A signed-in person uses it from the board. It needs `X-LogMem-Intent: work` and the same origin.
- `GET /api/view?what=lanes` returns every lane with: percent done, active jobs, the blocked count, parked jobs, and the next milestone.
- Home sorts plan cards P0 first, and leaves parked jobs out of Blocked.

## 5. The board

**Lanes** replaces Plans in the navigation, and a plan page is one lane in detail.

- **The P0 lane** is a large card: owner, progress, next milestone, the jobs moving now, and the jobs parked inside it.
- **Active lanes** and **Parked lanes** show as cards. A parked lane shows its reason and when it can unpark.
- **Buttons:** Make P0 (asks to confirm), Park (needs a reason), and Unpark.
- **Live:** the board updates through the pulse, like every other view.

## 6. Data (madez)

- `launch` is the P0 lane.
- The OpenACP x Super Bus build is an active lane.
- `fleet` is an active lane.
- Entry is a parked lane, per Mikey's Oct 19 ruling.
- Grok's parked items become parked jobs in their lanes: the Elestio scale plan, the customer Redis, pricing, the G-18 keys, and infra health. Owners do not move.
