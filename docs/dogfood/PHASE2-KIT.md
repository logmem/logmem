# Phase 2 kit: connect a Mac agent to LogMem (Oct 13–19)

Every Phase 2 agent uses the same server, space and flags. Only `LOGMEM_AGENT` changes.

| Var | Value |
|---|---|
| `LOGMEM_SPACE` | `madez` |
| `LOGMEM_ACMI_COMPAT` | `1` (also exposes `acmi_*`; reads merge ACMI history) |
| `LOGMEM_MIRROR_ACMI` | `1` (every write also lands in `acmi:madez:*`) |
| `LOGMEM_REST_URL` | `https://acmi-redis-u70402.vm.elestio.app/bridge/exec` |
| `LOGMEM_REST_TOKEN` | the fleet bridge token (same as `ACMI_BRIDGE_TOKEN`) |
| `LOGMEM_AGENT` | `claude-code` / `claude-engineer` / `grok-local` / `codex` |

Server: `node /Users/michaelshaw/clawd/projects/logmem/src/stdio/index.mjs`

## Claude Code

```bash
claude mcp add logmem --scope user -e LOGMEM_SPACE=madez -e LOGMEM_ACMI_COMPAT=1 -e LOGMEM_MIRROR_ACMI=1 -e LOGMEM_AGENT=claude-code -e LOGMEM_REST_URL=https://acmi-redis-u70402.vm.elestio.app/bridge/exec -e LOGMEM_REST_TOKEN=$ACMI_BRIDGE_TOKEN -- node /Users/michaelshaw/clawd/projects/logmem/src/stdio/index.mjs
```

## Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.logmem]
command = "node"
args = ["/Users/michaelshaw/clawd/projects/logmem/src/stdio/index.mjs"]
env = { LOGMEM_SPACE = "madez", LOGMEM_ACMI_COMPAT = "1", LOGMEM_MIRROR_ACMI = "1", LOGMEM_AGENT = "codex", LOGMEM_REST_URL = "https://acmi-redis-u70402.vm.elestio.app/bridge/exec", LOGMEM_REST_TOKEN = "<bridge token>" }
```

## grok-local / any MCP host (JSON)

```json
{ "mcpServers": { "logmem": { "command": "node",
  "args": ["/Users/michaelshaw/clawd/projects/logmem/src/stdio/index.mjs"],
  "env": { "LOGMEM_SPACE": "madez", "LOGMEM_ACMI_COMPAT": "1", "LOGMEM_MIRROR_ACMI": "1", "LOGMEM_AGENT": "grok-local",
           "LOGMEM_REST_URL": "https://acmi-redis-u70402.vm.elestio.app/bridge/exec", "LOGMEM_REST_TOKEN": "<bridge token>" } } } }
```

## Working rules (Phase 2)

1. First message of every session: `logmem start <you>`.
2. Coordinate the deliverable on `job:logmem-v0-ship`: `logmem_update` for progress, `logmem_handoff` to pass work, `logmem_note kind:accepted origin:<trail>` to take it.
3. Every day, at least one cross-agent handoff, answered with `accepted`.
4. If `logmem_connection` says `degraded: true`: stop, then report with `logmem_note kind:problem payload:{degraded:true}` once you're back.
5. Irreversible step (merge, publish, deploy to prod, `--apply`)? Use `logmem_ask` and wait for Mikey.
6. End of session: `logmem_recap`.

The daily check runs at 13:00 UTC. The scorecard is at `/scorecard.html` on the `feat/dogfood-phase0` preview (Vercel login).
