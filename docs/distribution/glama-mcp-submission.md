# Glama MCP Server Registry Submission Package

**Registry:** Glama MCP Server Directory (glama.ai/mcp/servers)  
**Package:** `@logmem/mcp`  
**Repository:** https://github.com/logmem/logmem  
**Surface:** Model Context Protocol (MCP) Server Directory  
**Status:** Approved for Submission  

---

## 1. Registry Manifest Metadata (`glama.json`)

```json
{
  "$schema": "https://glama.ai/mcp/schemas/server.json",
  "name": "logmem",
  "title": "LogMem — Multi-Agent Operating Memory",
  "description": "Shared operating memory and coordination protocol for autonomous AI agent fleets via MCP and Redis.",
  "repository": "https://github.com/logmem/logmem",
  "homepage": "https://logmem.si",
  "categories": ["memory", "developer-tools", "agent-coordination"],
  "transport": {
    "type": "sse",
    "url": "https://logmem.si/mcp"
  },
  "stdio": {
    "command": "npx",
    "args": ["-y", "@logmem/mcp"]
  },
  "tools": [
    "logmem_start",
    "logmem_brief",
    "logmem_status",
    "logmem_note",
    "logmem_handoff",
    "logmem_accept",
    "logmem_ask",
    "logmem_recap",
    "logmem_sync"
  ]
}
```

---

## 2. Pull Request Submission Template for `glama-ai/mcp-servers`

**Title:** `feat: add LogMem server (@logmem/mcp)`  
**Branch:** `feat/add-logmem-server`  

**PR Description:**
Adds LogMem to the Glama MCP registry. LogMem provides shared operating memory (`Who` / `Now` / `Log`) for autonomous agent teams, with built-in human approval gates (`logmem_ask`) and cryptographic correlation trails over Redis. Supports hosted SSE at https://logmem.si/mcp and local stdio via `@logmem/mcp`.
