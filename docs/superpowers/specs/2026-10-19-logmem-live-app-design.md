# LogMem web app: mission control, live and on every screen

Status: APPROVED by Mikey, 2026-10-19 (brainstorm with mockups). Owner: claude-code.
Builds on the work taxonomy spec (`2026-10-19-logmem-work-taxonomy-design.md`). It replaces build PRs 2 and 3 there.

## 1. Problem

- Every page is the same template: a heading, a panel and a table or a raw key list.
- Overview repeats the Agents and Log pages. The Jobs and Plan pages show the same table.
- Blocked jobs show no reason and no action. Blockers and Decisions are two inboxes for one person.
- Nothing updates until you reload.
- There is one small-screen rule (520px), and the 232px rail stays on phones.

## 2. Decisions (Mikey, 2026-10-19)

| Question | Decision |
|---|---|
| What Home answers | "Is the work moving?" (mission control) |
| View map | Six views, one question each (section 4). Needs you is a panel over every view |
| Home layout | Three columns on a laptop: Plans, Blocked, Agents |
| Where fixing happens | A side panel that slides in from the right. The same panel everywhere. Full screen on a phone |
| Live updates | A pulse every 4 seconds, with in-place updates |
| Phone navigation | A bottom tab bar |
| Home screen install | Yes: a manifest and an icon. No push yet |

## 3. Shared parts

Every view is built from one set of parts, so they all look and behave the same:

| Part | What it shows | Used in |
|---|---|---|
| Job card | Title, plan › track, stage, owner, what it waits on, one fix button | Home Blocked, Jobs board, Plans |
| Needs-you item | A decision or a task, with inline actions | Needs you panel, side panel |
| Side panel | One job: its tasks and decisions, Who and Now in plain words, its log | Opened from every view |
| Plan card | Percent done, next milestone and date, blocked count | Home, Plans |
| Agent chip | Live dot, Now, current job | Home strip, Agents, job owners |

**Fix buttons**, picked by `blocked_on.type`:

| Waits on | Button | What it does |
|---|---|---|
| A task | Open steps | Opens the side panel on the task |
| A decision | Answer | Opens the side panel on the decision |
| An agent | Nudge | On the card. Writes a ping from you, with an optional note |
| Outside the team | Unblock | On the card. Sets the job active with your note |
| No reason given | Ask owner why | On the card. Nudges the job owner |

**Actions** show at once, roll back if the server refuses, and confirm with a short toast. Every action writes an entry signed by the person on the job's log.

## 4. Views

| View | Question | Content |
|---|---|---|
| Home | Is the work moving? | Plans column (plan cards, then "general: N to file"), Blocked column (job cards, no-reason first, then longest blocked), Agents column (chips, "No Now set" flagged). Needs you badge in the header |
| Needs you (panel) | What must I do? | Decisions and tasks, soonest due first, each tagged plan › job. Approve, Reject, Defer (typed "approve" for irreversible). Tick steps, Done, Can't do |
| Plans | Where are we against the plan? | Plan picker, milestone rail (date, criteria, status), tracks with a progress bar and jobs grouped by milestone. Late jobs flagged |
| Jobs | Where is a given piece of work? | Board: Open, Active, Blocked, Done (last 7 days). Filters: plan, track, owner, search. A card opens the side panel |
| Agents | Who is doing what, and are they healthy? | A card per agent: Now (doing, job, next), last recap, handoffs waiting. Health: wrote in 15 minutes, answers handoffs, Now set |
| Log | What exactly happened? | Full record. Filters: plan, job, agent, kind, channel. Recall search at the top |

An Admin menu holds Settings, Audit, Waitlist, Keys and Connections. Channels become a Log filter.

## 5. Screen sizes

| Width | Layout |
|---|---|
| Phone, under 640px | Bottom tab bar: Home, Needs you (count), Plans, Jobs, More (Agents, Log, Admin). Home stacks Blocked, Plans (swipe), Agents. The board is one column with stage chips. Panels are full screen with a back arrow. Tap targets at least 44px. Decision buttons stick to the bottom |
| Tablet, 640 to 1024px | Icon rail. Home: Blocked and Plans in two columns, Agents below. Side panel 60% wide |
| Laptop, 1024 to 1440px | Full rail. Three columns. Side panel 480px |
| Wide, over 1440px | Content capped at 1600px. The side panel can be pinned open |

Everywhere: light and dark from the device, reduced motion respected (no glow or slide), Escape closes the panel, J and K move through cards. A web manifest and icon let a phone add the app to its home screen.

## 6. Live updates

- `store.append` increments `lm:{space}:rev` on every write, including web writes.
- `GET /api/pulse?space=` returns `{ rev }` with one Redis GET.
- The app checks every 4 seconds while visible, and every 30 seconds while hidden. A tab that comes back into view checks at once.
- On a new rev it refetches the open view and the Needs you count, then updates parts in place by key. Scroll, an open panel and typed text stay.
- New rows glow for 2 seconds. While a field has focus or a panel is open, a "N new updates" pill shows instead of changing the screen.
- The tab title shows the Needs you count, such as "(12) LogMem".
- Offline: a "Reconnecting…" chip, and checks back off from 4 to 60 seconds.

## 7. Server endpoints

All need a signed-in person and a space the app shows. Writes need `X-LogMem-Intent` and the same origin.

| Endpoint | Does |
|---|---|
| `GET /api/pulse?space=` | `{ rev }` |
| `GET /api/needs?space=` | The person's open tasks and decisions, each with plan and job |
| `POST /api/nudge { space, job, agent?, note? }` | A `ping` by the person on the job log and the agent's log. The agent defaults to the job owner |
| `POST /api/unblock { space, job, note }` | Sets the job `active`, clears `blocked_on`, writes a `progress` entry by the person. Only for jobs blocked on `external` or with no reason. Decision and task blocks clear by answering them |
| `GET /api/view?what=home` | Plans with percent, next milestone and blocked count. Blocked jobs with `blocked_on`, owner and blocked time. Agents with Now. The Needs you count |
| `/api/tasks` | The current `/api/blockers`, renamed. The old path stays as an alias |

## 8. Errors

- A 401 opens sign-in and returns to the same view after.
- A refused action rolls back and shows the server's message in the toast.
- A failed pulse shows "Reconnecting…" and backs off. The screen keeps its last data.

## 9. Tests

- Server: pulse, needs, nudge and unblock for auth, the intent header, other spaces, agent refusals and their entries. The rev counter goes up on every write.
- App: an in-place update keeps focus and typed text. Layouts checked in the browser at 375, 768, 1280 and 1600px wide.

## 10. Build order

1. **PR 2a, server:** rev, pulse, needs, nudge, unblock, Home data, the tasks rename.
2. **PR 2b, app shell:** shared parts, live updates, Home, the Needs you panel, the side panel, the phone layout, the manifest.
3. **PR 2c, views:** Plans, Jobs board, Agents, Log with Recall, the Admin menu.

## 11. Out of scope

Push notifications, WebSockets, dependencies between jobs, and editing a job's Who from the app.
