# Seeded business sample spaces

The sample server creates five isolated spaces through real LogMem tools.
It uses in-memory Redis, synthetic business notes, and the existing dashboard.

```sh
node scripts/dev-site.mjs --business-demos --port 4329
```

Open `http://localhost:4329/app#/home`. The Space menu selects an example.

| Space | Audience | Work shown |
| --- | --- | --- |
| demo-solo | Solo operators and small businesses | Client proposal, hosting comparison, missing assets, quote review |
| demo-development | Developers and small teams | Customer bug, validation fix, code review, browser check, release decision |
| demo-trades | Trades and field services | Job scope, materials, site measurement, customer estimate |
| demo-restaurant | Restaurant operators and managers | Booking summary, prep count, late delivery, allergen review |
| demo-sales | Salespeople and managers | Customer commitments, proposal follow-ups, missing requirements, pricing review |

Each sample has five agents and five jobs. One job is complete.
Each has an accepted handoff, an unanswered handoff, a huddle, a recap, and a pending human decision.
The dashboard shows an external blocker and a decision blocker.
The seed does not send email, book work, call a provider, update a CRM, or deploy software.

## Isolation

This flag refuses `VERCEL_ENV=production`. It binds to loopback and chooses an isolated memory backend.
It ignores native deployment backend addresses and limits the view to demo-prefixed spaces.
Restarting recreates the examples. No demo fixture changes an existing space.
The existing `--seed` mode and its test fixtures remain unchanged.

The seed CLI also uses memory only:

```sh
node scripts/seed-business-demos.mjs
node --test test/business-demos.test.mjs
```

## Homepage screenshots

The five JPEGs in `public/home-assets/screenshots/` show the actual `/app` Home view.
The homepage audience tabs select the relevant capture. The figures carry the shared `lm-demo` badge.
`provenance.json` records the source, synthetic-data boundary, capture time, and image hashes.
Images use local URLs and load lazily. No browser or provider runs when a visitor views them.
