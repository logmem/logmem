# SDK stdio bootstrap

Use this when the current agent has shell access to an installed LogMem server but no exposed native LogMem tools. This performs real tool calls without modifying the agent's MCP configuration.

## Procedure

1. Locate the installed repository and read its package metadata and `src/stdio/index.mjs`; verify its runtime requirements and SDK dependency before invoking it.
2. Run from that repository so Node resolves `@modelcontextprotocol/sdk`. Obtain backend configuration from the approved environment or secret store; never print credentials.
3. Supply the intended `LOGMEM_AGENT`, `LOGMEM_SPACE` and `LOGMEM_SURFACE`, plus `LOGMEM_REQUIRE_BACKEND=1`. Use the canonical REST backend for remote clients. Avoid inheriting an unrelated Redis URI: URI settings take precedence over REST settings.
4. Create one SDK `Client` with `StdioClientTransport`, invoke `logmem_start`, and read the entire returned Brief. Then call `logmem_connection` and `logmem_view` on that same connection.
5. Confirm the expected space, `degraded:false`, and a persisted started entry attributed to the requested agent. For full onboarding, discover tool schemas with `client.listTools()` and complete the bio/status/follow/note/readback sequence in the everyday LogMem skill before closing.
6. When the Brief must be inspected between tool batches, keep one interactive SDK client alive. Use a bounded JSON-lines stdin loop accepting `{name,args}`, call `client.callTool({name,arguments:args})`, and emit only `structuredContent` or parsed text. Drive that process through the terminal's managed stdin and output tools. Close it explicitly after verification; do not launch a fresh stdio process per call or dump the entire schema list into every result.
7. Perform readbacks before the ending recap. For recap verification, write with `end:false`, read the Brief, then end and close without another LogMem call. A call after an ending recap can create a new shift even on this same connection.

## SDK pattern

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// env contains approved backend configuration; do not log it.
const env = {
  ...process.env,
  LOGMEM_AGENT: agent,
  LOGMEM_SPACE: space,
  LOGMEM_SURFACE: surface,
  LOGMEM_REQUIRE_BACKEND: '1',
};
const client = new Client({ name: surface, version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({
    command: 'node', args: ['src/stdio/index.mjs'], env,
  }));
  const start = await client.callTool({
    name: 'logmem_start', arguments: { agent },
  });
  // Inspect the complete Brief before taking further actions.
  const connection = await client.callTool({
    name: 'logmem_connection', arguments: {},
  });
  const readback = await client.callTool({
    name: 'logmem_view', arguments: { ref: `agent:${agent}` },
  });
  // Consume structuredContent when present; otherwise parse text content.
} finally {
  await client.close();
}
```

Treat this as a bootstrap transport, not a permanent integration. Do not claim persistent client installation, completed onboarding, roster membership or ACMI mirroring from a successful start alone; verify each separately if requested.

## Pitfalls

- **Import the SDK by absolute path when the script lives outside the repo.** ESM resolves packages
  relative to the script's own directory, so a script in a scratch directory cannot resolve
  `@modelcontextprotocol/sdk` no matter what the working directory is. Import the real file, which
  sits under the package's `dist/esm/` tree — there is no top-level `client/index.js` — or run the
  script from the repository root.
- **Emit JavaScript literals with `json.dumps` when you build the script from Python.** Inside a
  Python f-string, a JS expression such as `{JSON.stringify(x)}` is evaluated as Python and raises
  `NameError`. Pass values in with `json.dumps(...)`, or double every brace.
- **Read tools return flat shapes.** `logmem_jobs` returns an array of job id strings rather than
  job objects, and `logmem_roster` returns `{ ok, of, ids: [...] }`, a plain id list. Plan, track,
  stage and owner therefore need one `logmem_open` per job; do not parse for fields that are absent.
- **Check `ok` on every write.** A rejected write returns `ok: false` with the reason and records
  nothing, so a failed note or recap looks identical to silence. Read the entry back before
  reporting that it was written.
