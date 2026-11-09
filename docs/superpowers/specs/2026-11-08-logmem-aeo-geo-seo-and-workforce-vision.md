# LogMem: AEO, GEO, SEO, Traffic Strategy & AI Workforce Operations ("Homebase for AI Agents")

**Date:** 2026-11-08  
**Author:** Fleet Architecture Working Group & Growth Strategy  
**Status:** Approved Strategic Roadmap  
**Space:** `madez`  

---

## Executive Summary

1. **Product Positioning:**  
   > **LogMem: The shared workspace for scheduling, coordinating, and supervising AI agents—with memory that survives every shift.**  
   > *Headline:* **Run your AI team without losing the work.**  
   > *Supporting:* **Shared memory, clear handoffs, and human decisions—across the agents you already use.**
2. **Workforce Operations Analogy:**  
   Homebase, 7shifts, and When I Work provide operational clarity for shift workers. For AI fleets, LogMem schedules **responsibility and capacity** (not 24/7 idle VMs), enforcing run leases, break/idle timeouts, and shift handovers.
3. **Acquisition Engine:**  
   SEO, AEO, and GEO are unified by one foundation: **publishing reproducible operational evidence**, solving real coordination headaches, and optimizing for **qualified workspace activation** rather than vanity traffic.

---

## 1. Workforce Concept Mapping ("Homebase for AI Agents")

| Workforce Management Concept | LogMem Operating Protocol Equivalent |
| :--- | :--- |
| **Employee Profile** | Agent identity (`Who`), model, capabilities, permissions, version |
| **Availability** | Runtime readiness, vaulted credentials, capacity, provider health |
| **Shift Schedule** | Coverage windows (Morning 09:00, Midday 13:00, Closeout 17:30 EST) |
| **Open Shift** | Unassigned job in committed queue requiring specific capabilities |
| **Clock-In (`logmem_start`)** | Verified run start, lease acquisition, and `Now` state activation |
| **Attendance & Compliance** | Heartbeat pings, 30-min idle auto-recap, missed-start exceptions |
| **Shift Handover (`logmem_recap`)** | Structured accomplishments, unblocked trails, and next shift handover |
| **Manager Approval (`logmem_ask`)** | Human-in-the-loop authorization before irreversible actions |
| **Labor Budget** | Per-shift token allowance, compute caps, and provider cost metering |
| **Timesheet / Audit** | Cryptographic run receipts and usage ledger |

---

## 2. Scheduling & Execution Architecture

```text
Agent Profile (Who) ──> Capability + Availability ──> Coverage Requirement
                                                             │
                                                             ▼
Handoff Handover <── Artifact Verification <── Run Lease + Checkpoints
```

### Critical Guardrails
* **No-Show Prevention:** A scheduled shift that fails to acquire its lease triggers an immediate out-of-band alert.
* **Capacity Reservation:** Prevents overlapping commitments or model concurrency limits.
* **Budget Metering:** Worst-case cost reserved before launch; prevents runaway token burns.
* **Separation of Concerns:** Scheduled coverage window $\neq$ constant running compute. Provision compute (Sandbox/VM) only when work is actively dispatched.

---

## 3. Organic Acquisition: SEO, AEO, and GEO

* **SEO (Search Engine Optimization):** Visibility in conventional web search (Google, Bing).
* **AEO (Answer Engine Optimization):** Direct, structured answers to technical operational queries.
* **GEO (Generative Engine Optimization):** Citation and recommendation in LLM search experiences (ChatGPT Search, Perplexity, Gemini).

### A. Technical Search Foundations (Immediate Marketing Site Action)
1. **Single Canonical Identity:** Consolidate public marketing on `logmem.si`, docs on `docs.logmem.si`, and application on `logmem.si/app`.
2. **Crawlable Semantic HTML:** Clean semantic markup, unique titles/meta, and `SoftwareApplication` JSON-LD schema.
3. **Robots & AI Bot Policy:** Explicitly allow `OAI-SearchBot` for search visibility while isolating model-training scrapers (`GPTBot`) if desired.
4. **Developer Convenience:** Deploy public `/llms.txt` and `/llms-full.txt` summarizing tools, protocol schemas, and quickstart commands.

### B. Problem-Led Content Strategy
Avoid mass-generated generic keyword spam. Publish authoritative solutions to real agent failure modes:
* *"How do AI agents share context between sessions without data loss?"*
* *"How do you prevent two autonomous agents from executing the same task?"*
* *"How should an AI agent request human approval before code deployment?"*
* *"How do you detect when an AI agent has stalled or failed silently?"*
* *"Can a second agent resume complex work using only a session Brief?"* (Original benchmark evidence).

---

## 4. North-Star Activation Funnel

```text
Qualified Visitor ──> Demo Viewed ──> Workspace Created ──> Agent Connected ──> First Durable Entry ──> First Accepted Handoff ──> Retained Team
```

**North-Star Metric:** **Time to First Accepted Handoff** (an operator connects an agent, records useful work, and successfully hands it to another agent or person).
