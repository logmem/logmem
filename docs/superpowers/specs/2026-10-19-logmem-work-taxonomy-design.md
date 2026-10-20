# LogMem work taxonomy: plans, jobs, tasks and decisions

Status: APPROVED by Mikey, 2026-10-19. Owner: claude-code.

## 1. Problem

The web app uses one word for two things and gives no way to fix what it shows.

- "Waiting on you" on Overview means decisions (asks). On Blockers and Plan it means person handoffs. Nothing joins the two.
- "Stuck" counts jobs at stage `blocked`. It shows no reason and no action.
- Jobs float free of plans. 21 of 158 jobs in space `madez` have no plan, and one job has a file path as its plan.
- Asks and person handoffs can sit on a channel or an agent log, so the work they block is not visible.
- The Overview, Plan and Jobs pages are thin.

## 2. Decisions (Mikey, 2026-10-19)

| Question | Decision |
|---|---|
| Structure | One tree: **Plan, then Job, then Task or Decision** |
| Every job | Belongs to exactly one plan |
| Every task and decision | Belongs to exactly one job, so it also belongs to a plan |
| Taxonomy | Locked by this spec. The app, the tools, the Brief and the skills all use these words |
| Person work name | **Task** |
| A person's inbox name | **Needs you** |
| Auto-link | A task or decision on a job blocks that job, and answering it unblocks the job |

## 3. The taxonomy

| Term | What it is | Rules |
|---|---|---|
| **Plan** | A named body of work, such as `launch` | Has an id, a title, an owner and an optional description. Every space has a `general` plan for work not yet filed |
| **Track** | A lane inside a plan, such as Build | A text field on the job. Free text, shown as a group |
| **Milestone** | A dated checkpoint in a plan | A job with `milestone: true`, a `date` and `criteria`. Replaces the word "gate" |
| **Job** | One piece of work with one owner | Stages `open`, `active`, `blocked`, `done`. Names its plan, and optionally its track and milestone |
| **Blocked** | A job stage that always has a reason | `blocked_on` is one of: a decision, a task, an agent, or something outside the team |
| **Task** | Steps only a person can do | A handoff to `human:<id>` on a job, with a walkthrough. The person ticks steps, marks Done, or says Can't do with a reason |
| **Decision** | A yes or no on one exact action | `logmem_ask` on a job. The person answers Approve, Reject or Defer |
| **Needs you** | A person's inbox | Every open task and decision for that person, newest due first, each linked to its job and plan |

Words we retire in the app: "Stuck" (now Blocked), "Blockers" (now Tasks), "Waiting on you" (now Needs you), "gate" (now milestone). The entry kind `stuck` stays for log entries, because it describes an event, not a job stage.

## 4. Data model and tool rules

### Plans

- Registry: `lm:{space}:plan:{id}` holds `{ id, title, owner, desc, created_at }`. The index is `lm:{space}:plan:list`.
- New tool `logmem_plan { plan, title, desc? }` creates a plan. It refuses an id that exists.
- `general` is created on first use in every space.
- `logmem_assign` requires `details.plan`. If it is missing, the job goes into `general` and the reply says so. If the plan does not exist, the call is refused and lists the plans. A plan id is a short slug. A path or URL is refused.
- `details.gate` is still read as the milestone, so old jobs keep working.

### Blocked

- `logmem_stage { stage: "blocked" }` requires `blocked_on: { type, ref?, note }`.
  - `type` is `decision`, `task`, `agent` or `external`.
  - `ref` is the trail (decision or task) or the agent id.
  - `note` is one plain line on what is needed.
- A job set to blocked without a reason is refused with an example.
- Old jobs at `blocked` with no reason show as "No reason given".

### Tasks and decisions

- `logmem_handoff` to `human:<id>` and `logmem_ask` both require `where: "job:<id>"`. A channel or agent log is refused, with a hint to open a job first.
- Asks with no `where` default to the job in the agent's Now (`now.job`). Without one, the call is refused.
- **Auto-link.** Creating a task or decision on a job sets the job to `blocked`, with `blocked_on` pointing to it. When every open task and decision on that job is answered, the job returns to `active`. The agent sees the outcome in its Brief.
  - Approve, Done: the job returns to `active`.
  - Reject, Can't do: the job returns to `active`, and the Brief marks it "needs a new path".
  - Defer: the job stays blocked.
- **Can't do.** New action for a task: the person gives a reason, the task closes, and an entry by the person goes on the job log.

### The Brief

- New field `needs_people`: every open task and decision the agent created, each with `{ type, trail, job, plan, summary, progress or verdict }`.
- `person_blockers` stays one release as an alias, then goes.
- `jobs` lists the agent's jobs with stage, plan and `blocked_on`.

## 5. The web app

**Navigation:** Overview, Needs you, Plans, Jobs, Agents, Channels, Log, Recall, then Settings, Audit and Waitlist. Blockers and Decisions merge into Needs you.

**Overview**

- Counts: Needs you (tasks plus decisions), Blocked jobs, Active jobs, Agents active.
- A Needs you panel: the top 5 items with their action buttons.
- A Blocked panel: each blocked job, its reason and one fix button (below).
- A Plans panel: each plan's percent done, next milestone and date, and its blocked count.
- Agents: each agent's Now (`doing`, job, blocked) and last entry.

**Needs you:** two tabs, Decisions and Tasks. Each item shows its plan and job as a breadcrumb.

**Plans:** a list of plans, then one plan's page:

- the milestone rail with dates and criteria
- each track with its jobs: stage, owner, due, milestone, evidence link and what it waits on
- the plan's open tasks and decisions, inline

**Jobs:** filters for plan, track, stage and owner. Columns: job, plan, stage, owner, due, waits on and last entry.

**Job page:** a breadcrumb (plan, then track), Who, Now, its open tasks and decisions with their actions, then its log.

**Fix paths for a blocked job.** One primary button, picked by `blocked_on.type`:

| Waits on | Button | What it does |
|---|---|---|
| A decision | Answer | Opens the decision |
| A task | Open steps | Opens the task's walkthrough |
| An agent | Nudge | Writes a `ping` from the person to that agent, linked to the job |
| Something outside the team | Unblock | The person sets the job `active` with a note |
| No reason given | Nudge owner | Shown in red. Writes a `ping` to the job owner asking for a reason |

Every person action writes an entry by that person on the job log. The mirror copies it to ACMI.

**Person APIs**

- `GET /api/needs`
- `POST /api/tasks`, the current `/api/blockers` renamed. The old path stays as an alias.
- `POST /api/decide`, unchanged.
- `POST /api/nudge`
- `POST /api/unblock`

Writes need `X-LogMem-Intent` and the same origin, as today.

## 6. Moving existing data

1. Create plans `launch` and `fleet`, plus `general` in space `madez`.
2. File the 21 jobs that have no plan:
   - the `review-pr*` jobs go to `launch`, track Reviews
   - `logmem-dogfood`, `logmem-v0-ship`, `logmem-google-search-setup`, `logmem-homepage-v3` and `logmem-skills` go to `launch`
   - `fleet-open-design`, `opencode-logmem-alignment` and `canonical-agent-doing` go to `fleet`
   - the rest go to `general` for triage
3. Fix `one-click-connect`: its file path moves to `plan_doc`, and its plan becomes `launch`.
4. Move `gate` into `milestone` on the 116 launch jobs. The value stays the same.
5. Asks and person handoffs not on a job show under plan `general`, job "Unfiled", until an agent files them.

The move is a dry run first, then an apply after Mikey's GO. It only adds fields and never deletes an entry.

## 7. Skills and canonical rules

- The product skill `logmem-jobs-plans-blockers` is renamed **`logmem-work`** and rewritten in these words. `logmem` and `logmem-decisions` point to it.
- `logmem-onboard-agent` requires three skills before the first task: `logmem`, `logmem-work` and `logmem-decisions`.
- Fleet `docs/LOGMEM-ROLLOUT.md` section 0 states the tree as fleet law: every job in a plan, every task and decision on a job, and Now kept true.
- The skills lint gains one check: an example call to `logmem_ask` or a person handoff must use `where: "job:..."`.

## 8. Build order (one PR each)

1. **Model and tools:** the plan registry, the required plan, `blocked_on`, auto-link, the job rule for asks and tasks, Can't do, and Brief `needs_people`.
2. **Needs you and fix paths:** the merged inbox, Nudge, Unblock, and the person APIs.
3. **Overview, Plans, Jobs and Job pages.**
4. **Skills and the fleet rules.**
5. **Moving the data** (section 6), after Mikey's GO.

## 9. Tests

- Assign without a plan files the job in `general`. An unknown plan or a path is refused.
- `blocked` without `blocked_on` is refused.
- An ask or person handoff off a job is refused.
- Auto-link: create a decision, and the job is blocked. Approve it, and the job is active. Defer it, and the job stays blocked. Two open items: answering one keeps the job blocked.
- Can't do closes the task, writes the person entry and returns the job to active.
- Nudge and Unblock write person entries with their mirror twins. Each refuses an agent session.
- `/api/needs` returns only the signed-in person's items, within the spaces shown.
- The Overview counts match `/api/needs` and the jobs at `blocked`.

## 10. Out of scope

- Plans that span spaces.
- Dependencies between jobs (job A waits on job B). `blocked_on.type = "agent"` covers most cases for now.
- Notifications outside the app (email, push).
