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

## Environment

The stdio server (`src/stdio/index.mjs` and the modules it loads) reads the variables below. None are required. With no Redis and no `LOGMEM_SPACE`, it warns and starts in memory on space `demo`.

| Variable | Required | Secret | Default |
|---|---|---|---|
| `LOGMEM_SPACE` | no | no | `demo`, or `ACMI_DEFAULT_TENANT`, or the first `LOGMEM_SPACES` entry |
| `LOGMEM_SPACES` | no | no | the resolved space |
| `LOGMEM_AGENT` | no | no | unset; the shift uses the client name |
| `LOGMEM_SURFACE` | no | no | MCP client name, else `stdio` |
| `LOGMEM_ACMI_COMPAT` | no | no | off |
| `LOGMEM_REDIS_URI` | no | yes | none (native Redis, checked first) |
| `LOGMEM_REST_URL` | no | no | none (REST URL, with `LOGMEM_REST_TOKEN`) |
| `LOGMEM_REST_TOKEN` | no | yes | none |
| `LOGMEM_REQUIRE_BACKEND` | no | no | off; set to `1` to exit instead of using memory |
| `LOGMEM_REDIS_TIMEOUT_MS` | no | no | `5000` |
| `LOGMEM_MIRROR_ACMI` | no | no | off |
| `LOGMEM_MIRROR_SPACES` | no | no | `madez`, only when mirroring is on |
| `LOGMEM_DECIDE_SECRET` | no | yes | unset; decisions stay disabled |
| `LOGMEM_WORK_RULES` | no | no | `strict`; `warn` allows a task or decision off a job, or blocked with no reason |
| `LOGMEM_ADMIN_ID` | no | no | `admin` |
| `ACMI_DEFAULT_TENANT` | no | no | none (legacy space fallback) |
| `ACMI_REDIS_URI` | no | yes | none (legacy alias of `LOGMEM_REDIS_URI`) |
| `ACMI_BRIDGE_URL` | no | no | none (legacy alias of `LOGMEM_REST_URL`) |
| `ACMI_BRIDGE_TOKEN` | no | yes | none (legacy alias of `LOGMEM_REST_TOKEN`) |
| `UPSTASH_REDIS_REST_URL` | no | no | none (legacy alias of `LOGMEM_REST_URL`) |
| `UPSTASH_REDIS_REST_TOKEN` | no | yes | none (legacy alias of `LOGMEM_REST_TOKEN`) |

`LOGMEM_URL` and `LOGMEM_PAIR` appear in the site probe script. This server does not read them.

## What's here

| Path | What it is |
|------|-----------|
| `src/server.mjs` | `createLogmem()`: one server, any transport |
| `src/core/vocab.mjs` | The LogMem ↔ ACMI dictionary (tools, kinds, fields, namespaces) |
| `src/core/keys.mjs` | Key layout `lm:{space}:{ns}:{id}:{slot}` (see [docs/KEYS.md](docs/KEYS.md)) |
| `src/core/store.mjs` | Storage, ms timestamps, compat reads of `acmi:*` |
| `src/core/session.mjs` | Shifts: auto Start, auto Recap (30 min idle), persona switch |
| `src/core/tools.mjs` | The 23 `logmem_*` tools |
| `src/compat/` | `acmi_*` tools and an ACMI `AcmiAdapter` for the conformance suite |
| `src/stdio/index.mjs` | stdio entry (`logmem-mcp`, the `npx @logmem/mcp` bin) |
| `api/mcp.mjs` | Streamable HTTP route (Vercel) |
| `api/oauth/`, `api/well-known/` | OAuth 2.1 + PKCE, ported from acmi-product, space-bound tokens |
| `api/inbox/[agent].mjs` | Drop work on an agent (writes a Handoff entry) |
| `reference/` | The ACMI originals this was built from, unchanged, for review diffs |

## Tools

23 tools, all as `logmem_<word>`: Start, Brief, Recap, Note, Handoff, Accept,
Ask, Status, Bio, View, Roster, Feed, Follow, Assign, Plan, Update, Stage, Open,
Jobs, Recall, Remove, Spaces, and Connection (`logmem_connection`). Names
follow the Action Map. Schemas are a **draft** until the tool-contract spec
(claude-engineer, Oct 14). Recall matches keywords in summaries and payloads.

| Tool | What it does |
|---|---|
| `logmem_plan` | List the plans in this space, or create one. A plan is a named body of work, such as 'launch'. Every job belongs to one plan; 'general' holds work not yet filed. |

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

`npm start` is `node src/stdio/index.mjs`. The environment table above is the
full list the stdio server reads. With no backend, stdio runs in memory and
`logmem_connection` reports `degraded: true`.

## License

[MIT](LICENSE). Copyright (c) 2026 Mad EZ Media.
