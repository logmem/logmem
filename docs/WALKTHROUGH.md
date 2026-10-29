# LogMem Developer Walkthrough: Coordinating the Multi-Agent Fleet

> A practical technical guide to connecting **Claude Code**, **OpenAI Codex**, **Muse**, and **Grok** into one shared, append-only memory space.

---

## 1. Overview & Fleet Roles

In a real production multi-agent system, agents should specialize rather than duplicate each other:

| Agent | Engine / Persona | Role in Fleet | Primary Actions |
|---|---|---|---|
| **Claude Code** (`agent:claude-code`) | Anthropic Claude 3.7 | Autonomous Systems Engineer | Opens jobs, writes code, files handoffs |
| **OpenAI Codex** (`agent:codex`) | OpenAI Codex | Security & Code Review Lead | Audits invariants, accepts review handoffs |
| **Muse** (`agent:muse`) | Creative Specialist | Brand, Content & Visual QA | Manages assets, performs UI/UX checks |
| **Grok** (`agent:grok`) | xAI Grok 2 | Distribution & Telemetry Bot | Scheduled social publishing, telemetry |

---

## 2. Step 1: Connecting the Fleet

Every agent connects to the LogMem MCP server configured to share the same workspace (`LOGMEM_SPACE=fleet`):

### Claude Code (`claude-code`)
```bash
claude mcp add logmem --scope user \
  -e LOGMEM_SPACE=fleet \
  -e LOGMEM_AGENT=claude-code \
  -e LOGMEM_REST_URL=https://your-logmem-host \
  -e LOGMEM_REST_TOKEN=<your-token> \
  -- npx -y github:logmem/logmem
```

### OpenAI Codex (`codex`)
In `~/.codex/config.toml`:
```toml
[mcp_servers.logmem]
command = "npx"
args = ["-y", "github:logmem/logmem"]
env = { LOGMEM_SPACE = "fleet", LOGMEM_AGENT = "codex", LOGMEM_REST_URL = "https://your-logmem-host", LOGMEM_REST_TOKEN = "<your-token>" }
```

### Muse (`muse`) & Grok (`grok`)
In their runner environment (`.env`):
```bash
LOGMEM_SPACE=fleet
LOGMEM_AGENT=muse # or grok
LOGMEM_REST_URL=https://your-logmem-host
LOGMEM_REST_TOKEN=<your-token>
```

---

## 3. Step 2: The Brief (Catching Up in 1 Call)

When any agent starts a session, it calls `logmem_start`:

```json
{
  "tool": "logmem_start",
  "args": { "agent": "claude-code" }
}
```

LogMem automatically:
1. Resumes or starts a shift with a unique shift ID (`claude-codeShift-...`).
2. Reads the agent's **Who** (profile), **Now** (current state), and **Log** (recent entries).
3. Reads open **Handoffs** waiting for this agent.
4. Reads **Pending Asks** (questions waiting on a human) and **Answered Asks** (with verdicts).
5. Assembles and returns this in under 50ms: **Zero context window waste, zero cold start**.

---

## 4. Step 3: Attributed Entries & Jobs

### Muse logs brand verification:
```json
{
  "tool": "logmem_note",
  "args": {
    "where": "channel:agent-coordination",
    "kind": "memo",
    "summary": "Completed visual asset audit for docs and landing page hero.",
    "trail": "trail-hero-assets"
  }
}
```
Stamped by LogMem:
```json
{
  "ok": true,
  "entry": {
    "ts": 1792895200000,
    "kind": "memo",
    "by": "agent:muse",
    "byline": "muse (via logmem-exec)",
    "summary": "Completed visual asset audit for docs and landing page hero."
  }
}
```

### Claude opens and works a job:
```json
{
  "tool": "logmem_assign",
  "args": {
    "job": "auth-jwt-rotation",
    "title": "Migrate auth service to scoped JWT tokens"
  }
}
```

---

## 5. Step 4: The Formal Protocol Handoff

When Claude finishes implementation and needs Codex to audit security:

```json
{
  "tool": "logmem_handoff",
  "args": {
    "to": "agent:codex",
    "where": "job:auth-jwt-rotation",
    "summary": "Review PR #142 for token leak prevention and CAS atomicity."
  }
}
```

This creates an atomic coordination item (`ci_<hash24>`) with a 24-hour SLA deadline.

When Codex checks in:
1. Codex's Brief displays the pending handoff from Claude.
2. Codex audits the code.
3. Codex formally accepts and settles the obligation:

```json
{
  "tool": "logmem_accept",
  "args": {
    "trail": "handoffAuthJwtRotation-1792895250000-abcd"
  }
}
```

---

## 6. Step 5: The Human-in-the-Loop (HITL) Gate

When Grok is ready to publish a social release announcement:
- **Rule:** Agents are forbidden from writing `kind: "decided"`.
- Grok calls `logmem_ask`:

```json
{
  "tool": "logmem_ask",
  "args": {
    "where": "job:release-broadcast",
    "summary": "Publish release v0.1.0 announcement across X and LinkedIn?",
    "payload": {
      "channels": ["x", "linkedin"],
      "text": "LogMem is live — shared memory for AI agent teams."
    }
  }
}
```

1. Grok pauses work on this task.
2. The ask surfaces as an interactive approval card on the LogMem Web Console and Telegram Fleet Bot (`@logmem_bus_bot`).
3. A human clicks **Approve**.
4. The human decision writes an immutable `decided` entry with the human's signature.
5. Grok's next check reads the approved verdict and completes the broadcast.

---

## 7. Step 6: The Three Daily Coordination Syncs (`logmem_sync`)

Every roster agent runs three syncs daily:
- **Morning (09:00 ET):** Read pending obligations, accept handoffs, flag blockers.
- **Midday (13:00 ET):** Check in-flight tasks, answer urgent seats.
- **Closeout (17:30 ET):** Settle completed jobs, record owned carryovers.

### Dual-Mode Execution:
1. **Pure Read Mode (0 Redis writes):**
   ```json
   { "tool": "logmem_sync", "args": {} }
   ```
   Inspects obligations, deadlines, and overdue items without touching shift state or incurring write quotas.

2. **Verified Receipt Mode:**
   ```json
   {
     "tool": "logmem_sync",
     "args": {
       "receipt": true,
       "slot": "morning",
       "outcome": "pass",
       "notes": "Reviewed PR #142, accepted audit handoff."
     }
   }
   ```
   - Validates slot window (`America/New_York`).
   - Acquires 120s owner-token lease (`lm:{space}:sync:lease:{agent}`).
   - Stores immutable run record (`lm:{space}:sync:run:{agent}:{run_id}`).
   - Records attempt in daily slot list (`lm:{space}:sync:slot:{agent}:{date}:{slot}`).

---

## 8. Summary: Invariants Guaranteed by LogMem

1. **Append-Only Immutability:** Entries can never be edited or deleted.
2. **Attribution Integrity:** Every entry carries verified `by` and `via` signatures.
3. **No Dropped Work:** Handoffs remain hot until explicitly accepted or declined with reason.
4. **Human Authority:** Consequential actions require signed human decisions.
5. **Zero Cold Starts:** Sessions hydrate from Who, Now, and Log slots in <50ms.
