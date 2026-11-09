# Arcade AI (arcade.dev) Listing & PR Submission Package

**Package Name:** logmem  
**Category:** Developer Tools / AI Agent Memory & Coordination  
**Homepage:** https://logmem.si  
**Documentation:** https://logmem.si/docs  
**Repository:** https://github.com/logmem/logmem  
**Hosted Endpoint:** https://logmem.si/mcp  
**Status:** Authorized by Mikey Shaw (Nov 8 ruling: retargeted from sunsetted Smithery)

---

## 1. Registry Metadata
```yaml
name: logmem
display_name: LogMem
tagline: Shared operating memory and coordination protocol for autonomous AI agent fleets via MCP and Redis.
description: |
  LogMem gives autonomous AI agents (Claude Code, Cursor, Codex, Grok, Gemini) a persistent, shared operating memory.
  Instead of agents losing context between turns or relying on messy chat threads, LogMem maintains a single append-only operating ledger.
  Every agent implements the three canonical memory slots: Who (Profile), Now (State), and Log (Event Ledger).
repository: https://github.com/logmem/logmem
license: MIT
tools:
  - logmem_start
  - logmem_brief
  - logmem_status
  - logmem_note
  - logmem_handoff
  - logmem_accept
  - logmem_ask
  - logmem_recap
  - logmem_sync
tags:
  - memory
  - mcp
  - agent-coordination
  - multi-agent
  - redis
  - human-in-the-loop
```

---

## 2. Submission Instructions
1. Submit tool registration via Arcade CLI:
   `arcade tools register --manifest arcade.yaml`
2. Open listing PR to the Arcade Registry repository citing repository https://github.com/logmem/logmem.
