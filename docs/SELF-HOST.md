# Self-host LogMem

Run the LogMem server against a Redis you own. Your data stays in your Redis.

This guide is for a self-hoster. It assumes you have Node 22 or later and a Redis you control.

## What you get

LogMem is an MCP server. It gives your AI tools one shared memory. They remember what already happened, hand work to each other, and ask you first before anything that cannot be undone.

Each tool gets a name that starts with `logmem_`. The most useful ones are:

| Tool | What it does |
|---|---|
| `logmem_start` | Starts a shift for one agent and returns a Brief of recent work |
| `logmem_note` | Writes one entry to a channel, a job or an agent log |
| `logmem_handoff` | Passes work to another agent |
| `logmem_accept` | Takes on a handoff that was passed to you |
| `logmem_brief` | Reads the handoffs and asks that wait for you |
| `logmem_recap` | Closes your shift and writes what changed |
| `logmem_connection` | Shows the backend, the space and the degraded flag |

## Step 1. Get the code and install

```bash
git clone https://github.com/madezmedia/logmem.git
cd logmem
npm install
```

The server is one package. There is nothing to build.

## Step 2. Point it at your Redis

The server needs a Redis. It accepts two kinds.

### A Redis server over TCP

```bash
export LOGMEM_REDIS_URI="redis://user:password@your-redis-host:6379"
```

Use `rediss://` instead when your Redis uses TLS. The host, the port, the user and the password all go in the URI.

### A Redis over HTTP REST

This suits a hosted Redis such as Upstash. You need the REST URL and the REST token.

```bash
export LOGMEM_REST_URL="https://your-instance.upstash.io"
export LOGMEM_REST_TOKEN="your-token"
```

When you set both a Redis URI and a REST URL, the server uses the Redis URI.

## Step 3. Name your space

A space is one walled-off memory. One team, one client or one project gets one space.

```bash
export LOGMEM_SPACE="my-team"
```

A stdio connection uses only the one space in `LOGMEM_SPACE`. Every key it reads or writes sits under `lm:my-team:`. No tool moves a connection to another space. To serve a second space, start a second server process with a different `LOGMEM_SPACE`.

## Step 4. Run it

```bash
node src/stdio/index.mjs
```

The server talks MCP over stdio, so an MCP client starts it. You do not run it as a long lived service by hand.

Check the backend with:

```bash
LOGMEM_SPACE=my-team LOGMEM_REDIS_URI="redis://..." node src/stdio/index.mjs
```

The `logmem_connection` tool reports the answer:

```json
{ "ok": true, "space": "my-team", "backend": "native", "degraded": false }
```

`degraded: false` means your Redis answered. See the next section if it does not.

## Step 5. Connect your AI tool

Add the server to the MCP config of each tool you use. Claude Code reads `~/.claude.json` or the project `.mcp.json`. Cursor reads `.cursor/mcp.json`. Codex reads `~/.codex/config.toml`.

The server command and the environment:

```json
{
  "mcpServers": {
    "logmem": {
      "command": "node",
      "args": ["/absolute/path/to/logmem/src/stdio/index.mjs"],
      "env": {
        "LOGMEM_SPACE": "my-team",
        "LOGMEM_REDIS_URI": "redis://user:password@your-redis-host:6379"
      }
    }
  }
```

Give every tool the same `LOGMEM_SPACE` value. That is what makes them share one memory.

The first call starts a shift for the agent. The tool name comes from the MCP client, so Claude Code shows as `claude` and Codex shows as `codex`. Set `LOGMEM_AGENT` to pin one name instead.

## Step 6. Try it

Ask your agent:

```
logmem start quill
```

Then give it a small task. It writes notes as it works.

Confirm the memory works across two tools. In tool A write:

```
logmem_note where=channel:field-notes summary="First note."
```

In tool B read:

```
logmem_feed refs=channel:field-notes
```

If tool B sees the note, the tools share one memory.

## When the server runs in memory

The server starts in memory when it cannot reach your Redis at startup. It reports `degraded: true` and tries your Redis again every 60 seconds.

Writes made while degraded stay in that process. They are not sent to your Redis and they are gone when the process exits.

Set `LOGMEM_REQUIRE_BACKEND=1` to make the server exit instead of starting in memory. Use this in production.

Common causes:

- The URI has no password, or the password has a character that must be escaped.
- The host needs TLS. Use `rediss://`.
- A firewall blocks the port.
- The user has no permission for the commands the server sends.

## Environment variables

| Variable | What it does |
|---|---|
| `LOGMEM_SPACE` | The space this connection is bound to. Default `madez` |
| `LOGMEM_SPACES` | Comma separated list of spaces a shared server may use. A stdio connection still uses only `LOGMEM_SPACE` |
| `LOGMEM_AGENT` | The agent name for the automatic Start. Default is the MCP client name |
| `LOGMEM_SURFACE` | The name shown in `agent (via surface)`. Default is the MCP client name |
| `LOGMEM_REDIS_URI` | A Redis URI. Wins over the REST URL |
| `LOGMEM_REST_URL` | An HTTP Redis REST URL |
| `LOGMEM_REST_TOKEN` | The token for the REST URL |
| `LOGMEM_REQUIRE_BACKEND` | Set to `1` to exit when the backend is unreachable |
| `LOGMEM_REDIS_TIMEOUT_MS` | Per command timeout. Default 5000 |
| `LOGMEM_ACMI_COMPAT` | Set to `1` to add the `acmi_*` tools and read legacy `acmi:*` history |
| `LOGMEM_MIRROR_ACMI` | Set to `1` to copy every write back to `acmi:*` for a gradual move |
| `LOGMEM_METER` | Set to `off` to stop counting use. By default LogMem counts adds, reads, recalls and active agents a month under `lm:{space}:usage:*`. It never limits anything |
| `LOGMEM_OAUTH_ALLOW_INSECURE` | Set to `1` to allow a plain `redis://` customer URI outside production |

`.env.example` in the repo lists every variable.

## ACMI compatibility

LogMem implements ACMI, the open protocol for agent memory. It keeps its own names. ACMI stays MIT under its own names.

Set `LOGMEM_ACMI_COMPAT=1` and the server adds 19 `acmi_*` tools. Every read then merges your legacy `acmi:*` history. Every new write still goes to `lm:*`.

Set `LOGMEM_MIRROR_ACMI=1` as well and each LogMem write is also copied to `acmi:*`. That lets agents you have not moved yet keep seeing new work. Turn the mirror off once every agent reads `lm:*`.

## Running the tests

```bash
npm test
npm run spec:check
npm run conformance
```

`npm run ci` runs all three. The conformance suite runs in memory. Set `LOGMEM_REDIS_URI` to run it against a real Redis. It uses a throwaway space and cleans up after itself.

## Security notes

- A plain `redis://` URI is only for a Redis on your own machine. Use `rediss://` for anything that leaves your machine. The server refuses a plain customer URI outside development.
- The server never writes to the legacy `acmi:*` keys unless you set `LOGMEM_MIRROR_ACMI=1`.
- A space is a wall. A connection bound to one space cannot read another. Use one space per client if you run an agency.
- Log entries are appended. Nothing rewrites an entry in place. A `logmem_remove` call can delete a whole log, and it always shows a preview first.
