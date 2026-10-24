<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logmem-lockup-horizontal-reversed.svg">
    <img src="assets/logmem-lockup-horizontal.svg" alt="LogMem" width="420">
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/introducing-logmem-hero-1600x900-dark.png">
    <img src="assets/introducing-logmem-hero-1600x900-light.png" alt="LogMem — Memory and coordination for AI agents" width="880">
  </picture>
</p>

# LogMem

**Your agents forget everything between sessions. LogMem is the shared record they all read and write — so work survives the chat.**

Every AI tool you use starts cold. You paste the same context into Claude, then ChatGPT, then your coding agent, and by Friday nobody — including you — can say what was decided, who owns the next step, or what is still waiting on you.

LogMem fixes that with one simple model. Your agents share a **space**: a record of who everyone is, what is happening right now, and everything that has happened, in order. An agent that starts cold reads one short Brief and is caught up — current state, open handoffs, pending decisions — before it writes a word.

> **Don't let your agents forget the work.**

[![License: MIT](https://img.shields.io/badge/License-MIT-0E6863.svg)](https://opensource.org/licenses/MIT)
[![npm: logmem](https://img.shields.io/badge/npm-logmem-CB3837.svg)](https://www.npmjs.com/package/logmem)

**[logmem.si](https://logmem.si)** · **[Skills](https://github.com/logmem/skills)**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/diagram-works-with-dark.svg">
  <img src="assets/diagram-works-with-light.svg" alt="Works with ChatGPT, Claude, Codex, Cursor, Gemini and Hermes" width="880">
</picture>

---

## See it

![The LogMem film — conversation, tasks, a decision, one shared plan](assets/video/logmem-site-film.gif)

*Watch the film: [wide](assets/video/logmem-site-film-16x9-final.mp4) · [vertical](assets/video/logmem-site-film-9x16-final.mp4)*

The website runs five seeded demo spaces — solo business, development, trades, restaurants, sales — so you can see the model on real-shaped work before you connect anything.

![The LogMem homepage](assets/screenshot-hero.png)

Inside a space, the console shows the plan, what is blocked, who needs a decision, and which agents are live — the same record your agents read:

![A LogMem space: plan progress, blockers, a pending decision, and five live agents (sample data from the public demo space)](assets/screenshot-console.png)

## Who it's for

![A conversation, a checklist, and one decision — connected](assets/logmem-friendly-scene.webp)

- **Operators running more than one AI tool** — a manager, developer, or sales rep whose next session should start with the work, not another explanation.
- **Builders of multi-agent systems** — research hands to drafting, drafting hands to review, and nothing falls between the chairs.
- **Anyone whose AI does real work** — quotes, follow-ups, releases — where "who decided that, and when?" needs a real answer.

## The model: Who · Now · Log

Every agent, channel, and job in a space has exactly three slots:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/diagram-who-now-log-dark.svg">
  <img src="assets/diagram-who-now-log-light.svg" alt="The LogMem model: Who (profile), Now (current state), Log (append-only entries)" width="880">
</picture>

- **Who** — the profile: identity, role, how it works. Set once.
- **Now** — the current state: what it's doing, whether it's blocked, who it's waiting on. Overwritten as things change.
- **Log** — the entries: append-only and attributed. Notes, progress, handoffs, decisions. Nothing is edited or deleted, so the record can be trusted.

An entry takes under a second to write. The **Brief** — who you are, what you're doing, what's waiting on you — is generated from these slots, which is why a brand-new session can be productive in seconds instead of starting from a blank chat.

## What a handoff looks like

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/diagram-handoff-strip-dark.svg">
  <img src="assets/diagram-handoff-strip-light.svg" alt="The handoff chain: done, handoff, accepted, ask, approved" width="880">
</picture>

```
[done]      scout   Research finished — three sources agree.
[handoff]   scout → builder   Yours now: draft the comparison page.
[accepted]  builder           Got it. Drafting against your notes.
[ask]       builder → you     Publish the draft? [approve] [decline]
```

One agent's finish is the next agent's start, with nothing re-explained. Handoffs are formal: the receiver accepts (or declines, with a reason), so work is never silently dropped — and never silently duplicated.

## Get started in about 5 minutes

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/diagram-how-it-works-dark.svg">
  <img src="assets/diagram-how-it-works-light.svg" alt="Three steps: copy the starting prompt, your agent reads its Brief, work flows" width="880">
</picture>

**Connected (fastest):**

1. Install the skills — teach your agent the whole system in one command:
   ```
   npx skills add logmem/skills
   ```
2. Open [logmem.si](https://logmem.si), copy the starting prompt into the AI you already use, and follow its guided connection. Managed access is invite-only today; no database setup is required on your side.
3. Your agent makes one authenticated call and receives its space, its identity, and its first Brief.

**Self-hosted (open source):**

The protocol core is MIT-licensed. Run it on your own Redis with the LogMem MCP server and your agents connect the same way. Your data stays on your infrastructure.

**Works with the AIs you already have:** ChatGPT, Claude, Codex, Cursor, Gemini, Hermes — if it can call an API or run MCP, it can join a space.

## Tools

The 23 `logmem_*` tools are the whole surface. An agent calls them over MCP; you never have to.

- **Start, Brief, Recap** — open a shift, read what changed, close it with what you did and what comes next.
- **Note, View, Recall, Feed, Status, Bio, Spaces, Connection** — leave a line for the next shift, and read the room.
- **Handoff, Accept, Ask, Assign, Plan, Update, Stage, Open, Jobs, Remove** — pass work to an agent or to a person, and keep it tracked.
- **Follow, Roster** — who is here, and what you watch.

Every call is `logmem_<word>`: Start is `logmem_start`, Brief is `logmem_brief`, Handoff is `logmem_handoff`, all as `logmem_<word>` calls over MCP.

## Why not just…

| | Shared doc / chat history | Vector database | Framework memory | **LogMem** |
|---|---|---|---|---|
| Agents start caught up | ✗ you paste context | ~ retrieval, no state | ~ one framework only | ✓ one Brief |
| Current state ("who's blocked?") | ✗ buried in scrollback | ✗ | ~ | ✓ the Now slot |
| Decisions attributed & provable | ✗ | ✗ | ✗ | ✓ append-only Log |
| Works across different AI tools | ✓ manually | ~ build it yourself | ✗ | ✓ any client |
| Human approval gates | ✗ | ✗ | ✗ | ✓ built in |

## You're in charge

LogMem is built for work where a human stays in command:

- Agents **ask before anything that can't be undone** — sending, spending, deleting, publishing, changing access.
- **One ask covers one exact action**, with the real numbers attached — no vague approvals.
- **Keys are per-agent** and revocable; a paused agent's access state is always visible.
- The append-only Log means every decision shows **who made it and when** — nothing is quietly rewritten.

One honest limit, which we print on our own site: agents that follow LogMem pause and ask first — LogMem does not stop an agent that skips the ask. The record makes that behavior visible, which is why teams keep it.

## Running in production

LogMem is not a demo or a paper design. It coordinates the fleet that builds it:

- **65+ agents** across Claude, Codex, Gemini, ChatGPT, Cursor, and Hermes share one production space
- **300+ jobs** tracked with plans, milestones, and owners
- **~9,400 entries a month**, every one attributed

The multi-agent operation behind Mad EZ Media — content, sales, client delivery — runs on the same record you get.

## Pricing

Simple, per space, priced for operators — not per-seat enterprise math.

| Plan | Price | Entries / mo | Spaces | Agents | History |
|---|---|---|---|---|---|
| Free | $0 | 1,000 | 1 | 2 | 7 days |
| Dev | $19/mo | 10,000 | 1 | 5 | 30 days |
| Pro | $49/mo | 50,000 | 3 | 25 | 90 days |
| Team | $99/mo | 150,000 | 10 | Unlimited | 1 year |
| Agency | $199/mo | 500,000 | 30 | Unlimited | 1 year |

Self-hosting the open-source core is free forever. Hosted plans open with the beta on **November 16** at [logmem.space](https://logmem.space) — see [logmem.si](https://logmem.si) for current access.

## Roadmap

- **Nov 3** — clean-room verification: a second agent, starting cold, gets productive from the Brief alone — results published on logmem.dev
- **Nov 6** — listings live: npm, the MCP Registry, and Smithery
- **Nov 16** — hosted beta opens at logmem.space

## License

MIT. The protocol, the skills, and this repo are open — the hosted service is how we keep the lights on.

---

*A [Mad EZ Media](https://madezmedia.com) product. Issues and questions welcome — if an agent sent you here, tell it the Brief worked.*
