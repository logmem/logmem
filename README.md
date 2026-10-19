# LogMem MCP

Shared memory for agent teams, as an MCP server. LogMem implements
[ACMI](https://github.com/madezmedia/acmi) and keeps its own names; ACMI stays
MIT under its own names.

Install and run the stdio server with:

```bash
npx @logmem/mcp
```

The product site is https://logmem.si. License: [MIT](LICENSE), Copyright (c) 2026 Mad EZ Media.

## Install

```bash
npx @logmem/mcp
```

That runs the `logmem-mcp` bin (`src/stdio/index.mjs`). `logmem-mcp --help`
prints usage and exits. `logmem-mcp --version` prints the package version.
Pass the space and backend through the environment:

```bash
LOGMEM_SPACE=your-space LOGMEM_AGENT=quill \
  LOGMEM_REST_URL=your-redis-url LOGMEM_REST_TOKEN=space-token \
  npx @logmem/mcp
```

If `LOGMEM_SPACE` is not set, the process warns on stderr and uses `demo`.

## What's here

| Path | What it is |
|------|-----------|
| `src/server.mjs` | `createLogmem()`: one server, any transport |
| `src/core/vocab.mjs` | The LogMem ↔ ACMI dictionary (tools, kinds, fields, namespaces) |
| `src/core/keys.mjs` | Key layout `lm:{space}:{ns}:{id}:{slot}` (see [docs/KEYS.md](docs/KEYS.md)) |
| `src/core/store.mjs` | Storage, ms timestamps, compat reads of `acmi:*` |
| `src/core/session.mjs` | Shifts: auto Start, auto Recap (30 min idle), persona switch |
| `src/core/tools.mjs` | The 22 `logmem_*` tools |
| `src/compat/` | `acmi_*` tools and an ACMI `AcmiAdapter` for the conformance suite |
| `src/stdio/index.mjs` | stdio entry (`logmem-mcp`, the `npx @logmem/mcp` bin) |
| `api/mcp.mjs` | Streamable HTTP route (Vercel) |
| `api/oauth/`, `api/well-known/` | OAuth 2.1 + PKCE, ported from acmi-product, space-bound tokens |
| `api/inbox/[agent].mjs` | Drop work on an agent (writes a Handoff entry) |
| `reference/` | The ACMI originals this was built from, unchanged, for review diffs |

## Tools

22 tools, all as `logmem_<word>`: Start, Brief, Recap, Note, Handoff, Accept,
Ask, Status, Bio, View, Roster, Feed, Follow, Assign, Update, Stage, Open,
Jobs, Recall, Remove, Spaces, and Connection (`logmem_connection`). Names
follow the Action Map. Schemas are a **draft** until the tool-contract spec
(claude-engineer, Oct 14).

## Shifts

- First call in a session with no open shift starts one automatically
  (agent = `LOGMEM_AGENT`, else the client name).
- 30 minutes idle: the next call (or the stdio timer) writes an automatic
  Recap of the old shift, then starts a new one.
- `logmem start <agent>`: if someone else holds the shift, they get a Recap
  first, then the new agent starts and gets a Brief.
- Every entry carries `by`, `via` and `byline: "quill (via claude-code)"`.

## ACMI compatibility

`LOGMEM_ACMI_COMPAT=1` adds the 19 `acmi_*` tools and makes every read merge in
legacy `acmi:{space}:*` keys (fields, kinds and timestamp units translated).
Writes always go to `lm:*`.

```bash
npm run conformance
```

Runs the ACMI conformance suite against the compat adapter (in-memory). Set
`LOGMEM_REDIS_URI` to run against a real Redis (a throwaway space, cleaned up
after) and `ACMI_CONFORMANCE` to point at a different suite build.

## Run from a checkout

```bash
npm install
npm test
LOGMEM_SPACE=madez LOGMEM_REDIS_URI=redis://localhost:6379 npm start
```

`npm start` is `node src/stdio/index.mjs`. See `.env.example` for every
variable. With no backend, stdio runs in memory and `logmem_connection`
reports `degraded: true`.

## License

[MIT](LICENSE). Copyright (c) 2026 Mad EZ Media.
