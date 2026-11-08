# Agent Shift & Coordination Scheduler ("Homebase for AI Agents")

**Specification & Operating Model**
**Date:** 2026-11-08  
**Status:** Approved for Implementation  
**Space:** `madez`  
**Reference Analogs:** Homebase, 7shifts, HotSchedules  

---

## 1. Executive Summary

Workforce management software like Homebase and 7shifts solved the chaos of restaurant and retail shifts: who is scheduled, who clocked in, what station they are working, break compliance, shift trades, and end-of-shift manager logbooks.

AI agent fleets suffer from the exact same operational failure modes:
1. **Uncertain presence**: An agent reporting activity does not prove it is actively running or monitoring work.
2. **Dropped handoffs**: Tasks sit in queues with no agent assigned to clear them before the 24-hour SLA expires.
3. **Unbounded runs & cost overruns**: Agents get stuck in loops or spin up without clear deliverables or budget limits.
4. **Missing closeouts**: Sessions die or time out without leaving a structured shift recap for the next agent.

The **Agent Shift & Coordination Scheduler** establishes a structured workforce management layer on top of LogMem and ACMI primitives, organizing autonomous agents into predictable, auditable shifts.

---

## 2. Shift Typology & Stations

Every scheduled agent shift belongs to an explicit **Shift Type** and is assigned to a designated **Station**:

| Shift Type | Primary Objective | Typical Duration | Mandatory Output |
| :--- | :--- | :--- | :--- |
| **`coordination-slot`** | Daily cadence sync (Morning 09:00, Midday 13:00, Closeout 17:30 EST) | 5–15 min | Cryptographic sync receipt (`pass` / `partial` / `failed`) |
| **`handoff-clearing`** | Triage inbox, accept pending handoffs, resolve blockers within 24h SLA | 15–30 min | Acceptance notes or resolved handoff deliverables |
| **`deep-drive`** | Focused engineering, code review, test suite runs, or document drafting | 1–3 hours | Pull request, passing test receipt, or written artifact |
| **`roundtable`** | Cross-agent brainstorming, architecture huddle, or multi-agent debate | 30–60 min | Decision ask (`logmem_ask`) or architecture spec |

### Stations
Agents clock into specific functional stations:
* **Station A (Engineering & PRs):** `claude-code`, `opencode`
* **Station B (Layer 0 Review & Safety):** `codex`
* **Station C (QA & Device Testing):** `muse`, `polar`
* **Station D (Workspace & Webmaster):** `gemini-app`
* **Station E (Ops & Infrastructure):** `ops-center`, `hermes`

---

## 3. The 4-Stage Shift Lifecycle

```
[ Scheduled ] ──> [ Clocked In ] ──> [ Active / On Station ] ──> [ Recapped / Clocked Out ]
       │                 │                      │                          │
       ▼                 ▼                      ▼                          ▼
Slot in calendar    logmem_start         Telemetry ping /          logmem_recap filed
(Auto or Manual)   (shift ID bound)     Progress notes logged    (Pass receipt stored)
```

### 1. Shift Publication & Claim
- Shifts are published to the space schedule weekly or dynamically generated from open jobs.
- An open shift can be claimed by an authorized runner or scheduled via local cron / GitHub Actions / Vercel Cron.

### 2. Clock-In (`logmem_start`)
- Agent starts the shift specifying its identity, mode (`quiet`, `fleet`, `operator`), and assigned station.
- LogMem registers a unique `shift_id` (e.g. `gemini-appShift-1794116438589-...`).
- State shifts from `idle` to `active` with explicit `doing` and `current_tasks`.

### 3. Shift Execution & Compliance
- **Break / Idle Timeout**: If an agent produces no log entries for 30 consecutive minutes, LogMem triggers an automatic idle-timeout recap to prevent zombie sessions.
- **Budget & Resource Cap**: Shifts are assigned a hard spending limit (e.g. max $0.50 token budget). When exceeded, the runner pauses and files an ask.

### 4. Clock-Out & Shift Recap (`logmem_recap`)
- Before ending the shift, the agent must file a formal recap answering:
  1. *What was accomplished?* (concrete PRs, files, or receipts).
  2. *What is blocked or handed off?* (unresolved items with trail IDs).
  3. *What should the next shift tackle?* (bulleted immediate next steps).

---

## 4. Shift Swaps, Call-Offs & Emergency Coverage

Just like human workforce tools, the scheduler accommodates outages, rate limits, and priority pivots:

1. **Shift Swap / Handoff Trade**:
   - If an agent hits provider rate limits (e.g., Groq rate limit or Anthropic token threshold), it logs a `stuck` entry and issues a `logmem_handoff` to a designated backup agent (e.g., passing from `claude-code` to `gemini-app`).
2. **Manager Call-Off / Pause**:
   - The human operator can pause or cancel an upcoming shift directly from the schedule UI without modifying crontabs.
3. **Emergency Shift Dispatch ("Call-in")**:
   - Operators can trigger an instant 15-minute emergency shift for any agent to address P0 production incidents.

---

## 5. Daily Coordination Slot Cadence (America/New_York)

The standard three-slot baseline guarantees that no handoff remains uninspected for more than 8 working hours:

* **Slot 1: Morning Kickoff (09:00 EST)**
  - Goal: Review overnight PR merges, check production health (`/api/health`), triage open inbox handoffs, set daily lane priorities.
* **Slot 2: Midday Check (13:00 EST)**
  - Goal: Inspect mid-flight blockers, review pending human decisions, unblock peer agents.
* **Slot 3: Closeout & Handover (17:30 EST)**
  - Goal: File daily audit scorecard, record 7-day gate passing status, ensure all overnight tasks are assigned with clean trails.

---

## 6. Data Model (`lm:schedule:*`)

```typescript
export interface AgentShift {
  id: string; // shift_YYYYMMDD_agent_slot
  agent: string; // e.g. "gemini-app"
  space: string; // e.g. "madez"
  station: 'engineering' | 'review' | 'qa' | 'webmaster' | 'ops';
  type: 'coordination-slot' | 'handoff-clearing' | 'deep-drive' | 'roundtable';
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  status: 'scheduled' | 'active' | 'completed' | 'missed' | 'swapped';
  slotName?: 'morning' | 'midday' | 'closeout';
  budgetCapUsd?: number;
  actualCostUsd?: number;
  receiptId?: string;
  recapSummary?: string;
  clockInTime?: number;
  clockOutTime?: number;
}
```
