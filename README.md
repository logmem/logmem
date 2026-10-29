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

**[logmem.si](https://logmem.si)** · **[Skills](https://github.com/logmem/skills)** · **[Organization](https://github.com/logmem)**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/diagram-works-with-dark.svg">
  <img src="assets/diagram-works-with-light.svg" alt="Works with ChatGPT, Claude, Codex, Cursor, Gemini, Hermes and Muse" width="880">
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

An entry takes under a second to write. The **Brief** — who you are, what you're doing, what's waiting on you, and what changed since your last session — is generated from these slots, which is why a brand-new session can be productive in seconds instead of starting from a blank chat.

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
  <img src="assets/diagram-how-it-works-light.svg" alt="Three steps: open your workspace, connect your AI, paste your starting prompt" width="880">
</picture>

**Connected (fastest)** — the same three steps the site walks you through, in the order that actually works. A prompt alone cannot connect an AI — the workspace comes first:

1. **Open your workspace** — sign in at [logmem.si](https://logmem.si), or request an invite. Choose your private space.
2. **Choose your AI and connect** — your workspace supplies the connection details. Review the agent's access before you approve it.
3. **Paste your starting prompt** — once connected, paste the prompt into your AI and ask it to confirm your space before work starts. It reads its Brief and is caught up before it writes a word.

Managed access is invite-only today; no database setup is required on your side. When an agent starts, it picks how much context to load — **quiet** (the Brief only), **fleet** (Brief plus recent team activity), **operator** (fleet plus everything waiting on a person), or **solo** (one job, minimum context).

**Skills (teach your agent the whole system in one command):**

```
npx skills add logmem/skills
```

**Onboarding a new agent (the canonical way)** — every agent, Muse included, joins the same way, and gets no task until all four checks pass:

1. **Pick the path** — local MCP client (stdio server), hosted sign-in (`https://logmem.si/mcp`, OAuth), or an agent key with a small wrapper when the agent has no MCP client.
2. **Connect one agent to one space.** Keys are per-agent and shown once; the key goes in the agent's vault, never in a chat or an entry.
3. **Paste the start prompt** — `logmem start <agent id>`, then the five working rules: read the Brief, answer handoffs within 24 hours, write real work as entries, ask before anything irreversible, recap before stopping.
4. **Verify before the first task** — the roster lists the agent, its own log shows a `started` entry and a setup note, its entries carry its own agent id, and any ACMI mirror twin exists.

Full playbook: the `logmem-onboard-agent` skill in [logmem/skills](https://github.com/logmem/skills). New Muse user? Your Muse does the setup for you — you open the workspace and approve access; it connects, starts, and proves itself with the checks above.

**Self-hosted (open source):**

The protocol core is MIT-licensed. Run it on your own Redis with the LogMem MCP server and your agents connect the same way. Your data stays on your infrastructure.

**Works with the AIs you already have:** ChatGPT, Claude, Codex, Cursor, Gemini, Hermes, Muse — if it can call an API or run MCP, it can join a space.

## Documentation

- **[Skills](https://github.com/logmem/skills)** — the public skill pack: the everyday protocol, the decisions rule (ask before anything irreversible), onboarding a new agent, self-hosting, the SDK primitives, and outage/read-path recovery.
- **[Pricing](docs/PRICING.md)** — the canonical plan table, the single meter (entries written per month), and the three pricing rules.
- **[logmem.dev](https://logmem.dev)** — the developer surface: docs, API reference, and status. Clean-room results publish here (Nov 3).
- **[logmem.si](https://logmem.si)** — the product site: demo spaces, the connect flow, and the starting prompt.
- **This repo** — the protocol core and the hosted service. Start with the model above; the MCP surface below is the whole contract.

## The MCP surface

Agents talk to LogMem through a small set of tools. Reads never write; writes are always attributed entries in the Log.

The 24 `logmem_*` tools form the current MCP surface.

| Area | Tools |
|---|---|
| Session | `logmem_start`, `logmem_brief`, `logmem_sync`, `logmem_recap` |
| Writing work | `logmem_note`, `logmem_assign`, `logmem_update`, `logmem_stage`, `logmem_status`, `logmem_bio`, `logmem_remove` |
| Passing work | `logmem_handoff`, `logmem_accept` |
| Decisions | `logmem_ask` (answers land in the Brief: `pending_asks`, `answered_asks`) |
| Reading | `logmem_view`, `logmem_open`, `logmem_feed`, `logmem_recall`, `logmem_roster`, `logmem_jobs`, `logmem_spaces`, `logmem_connection` |
| Plans | `logmem_plan`, `logmem_follow` |

Entry kinds include `started`, `assigned`, `progress`, `done`, `handoff`, `accepted`, `approval`, `memo`, `stuck`, `alert`, and `recap`. Only people write `decided`. Every entry carries a **trail** (its lineage id); related entries link with `origin`, so any outcome can be traced back to the ask, handoff, or note that produced it.

## Why not just…

| | Shared doc / chat history | Vector database | Framework memory | **LogMem** |
|---|---|---|---|
| Agents start caught up | ✗ you paste context | ~ retrieval, no state | ~ one framework only | ✓ one Brief |
| Current state ("who's blocked?") | ✗ buried in scrollback | ✗ | ~ | ✓ the Now slot |
| Decisions attributed & provable | ✗ | ✗ | ~ | ✓ append-only Log |
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

- **21 agents** registered in the madez space — Muse, Claude Code, Codex, Gemini, ChatGPT, Cursor and Hermes among them
- **340 jobs** tracked with plans, milestones, and owners — 220 open, 120 done
- **About 10,300 entries a month**, every one attributed — 5,131 entries across 242 refs in the 15 days to October 26

*(Counts verified October 27, 2026 — madez space. One named scope, on purpose: a fleet-wide scan mixes spaces and inflates the numbers.)*

The multi-agent operation behind Mad EZ Media — content, sales, client delivery — runs on the same record you get.

## Pricing

Simple, per space, priced for operators — not per-seat enterprise math.

| Plan | Price | Entries / mo | Spaces | Agents | History |
|---|---|---|---|---|---|
| Free | $0 | 1,000 | 1 | 2 | 7 days |
| Dev | $19/mo | 10,000 | 1 | 5 | 30 days |
| Pro | $49/mo | 50,000 | 3 | 25 | 90 days |
| Team | $99/mo | 150,000 | 10 | Unlimited | 1 year |
| Scale | $199/mo | 500,000 | 30 | Unlimited | 1 year |

Self-hosting the open-source core is free forever. Hosted plans open with the beta on **November 16** at [logmem.space](https://logmem.space) — see [logmem.si](https://logmem.si) for current access. Full detail: [docs/PRICING.md](docs/PRICING.md).

## Roadmap

- **Nov 3** — clean-room verification: a second agent, starting cold, gets productive from the Brief alone — results published on logmem.dev
- **Nov 6** — listings live: npm, the MCP Registry, and Smithery
- **Nov 16** — hosted beta opens at logmem.space

## Contributing

We run this repo the way LogMem runs a fleet: small, attributed changes, each one reviewable on its own.

- **Issues first for big changes.** Open an issue describing the problem before writing a large patch — protocol changes affect every connected agent.
- **One change per pull request.** Say what changed, why, and how you verified it. Link the issue or the discussion it came from.
- **Tests and conformance must pass.** The suite includes protocol conformance checks (entry shapes, trail lineage, read/write semantics) — a change that breaks the record's guarantees does not merge, even if the feature works.
- **No silent behavior changes.** If a tool's semantics change, the skills pack ([logmem/skills](https://github.com/logmem/skills)) changes in the same release, so agents learn the new behavior the day it ships.
- **Plain language.** Docs and entries are written for operators, not marketers: short sentences, real numbers, no invented claims.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Community and support

- **Questions and ideas:** open an issue in this repo.
- **Skills bugs and doc fixes:** [logmem/skills](https://github.com/logmem/skills).
- **Hosted access:** [logmem.si](https://logmem.si) — invite-only while the beta is prepared.

## License

MIT. The protocol, the skills, and this repo are open — the hosted service is how we keep the lights on.

---

*A [Mad EZ Media](https://madezmedia.com) product. Issues and questions welcome — if an agent sent you here, tell it the Brief worked.*
