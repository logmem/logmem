# LogMem tool contract — v0.1 (draft for G1)

Owner: claude-engineer · Builder: claude-code · HITL: mikey · Work item: `logmem-server-v0-20261011`
Status: **DRAFT**, opened 2026-10-11 (due 2026-10-14). Naming source of truth: the LogMem Action Map.

Machine-readable schemas: [`tools.schema.json`](tools.schema.json), generated from the code by
`node scripts/gen-spec.mjs`. `--check` fails if the code and the file disagree. Where this page
and the JSON disagree, the JSON is what the server actually does, and the difference is a bug.

---

## 1. Principles

1. **One verb per tool, one word per verb.** `logmem_<word>`, lowercase, no underscores after the prefix.
2. **Plain words in, plain words out.** Descriptions are written for the model *and* the person reading over its shoulder. No ACMI jargon in `logmem_*` descriptions.
3. **Objects, not JSON strings.** `logmem_*` tools take real objects (`now`, `who`, `payload`, `details`). Only the `acmi_*` compat tools keep ACMI's JSON-string parameters.
4. **The connection picks the space.** No `logmem_*` tool takes a `space` argument. Isolation is not a parameter.
5. **Reads never write.** Every tool marked `readOnlyHint: true` performs zero writes, apart from shift bookkeeping (§5).
6. **Irreversible means ask.** Anything a human can't undo goes through `logmem_ask` first. `logmem_remove` always previews.

## 2. Parameter vocabulary (normative)

| Param | Means | Shape |
|---|---|---|
| `agent` | an agent id | `quill` or `agent:quill` |
| `to` | the **agent** receiving something (handoff only) | agent id |
| `where` | **which log** to write to or read from | ref: `channel:<id>`, `job:<id>`, `agent:<id>`; a bare id = channel |
| `job` | a job id | `issue-14` or `job:issue-14` (ACMI `work:` accepted) |
| `ref` / `refs` | entity reference(s) for reads | ref as above |
| `summary` | the one-line entry text | string |
| `kind` | entry type, from §4 | LogMem word; ACMI kind accepted and translated |
| `trail` | id shared by every entry about one piece of work | string; auto `<kind><Id>-<ms>` if omitted |
| `origin` | trail of the entry this one follows from | string |

**Change from the v0 build:** `logmem_note.to` → `where`, and `logmem_handoff.job` → `where`. Now `to` always means an agent.

## 3. Tools

R = read only, W = writes. ACMI column = the tool it stands in for under compat mode.

| Tool | Word | R/W | Required | Optional | ACMI |
|---|---|---|---|---|---|
| `logmem_start` | Start | W | `agent` | `model` | `acmi_spawn` (+ bootstrap) |
| `logmem_brief` | Brief | R | — | `agent` | `acmi_bootstrap` |
| `logmem_recap` | Recap | W | `notes` | `next[]`, `end` | `acmi_rollup_set` |
| `logmem_note` | Note | W | `where`, `summary` | `kind`, `trail`, `origin`, `payload` | `acmi_event` |
| `logmem_handoff` | Handoff | W | `to`, `summary` | `where`, `trail`, `origin` | *new* (event + active) |
| `logmem_ask` | Ask | W | `question`, `action`, `reversible` | `where`, `origin` | *new* (decision-request) |
| `logmem_status` | Status | W | `now{}` | `agent` | `acmi_signal` |
| `logmem_bio` | Bio | W | `who{}` | `agent`, `replace` | `acmi_profile` |
| `logmem_view` | View | R | `ref` | `limit` (10) | `acmi_get` |
| `logmem_roster` | Roster | R | — | `of` ∈ agent·channel·job | `acmi_list` |
| `logmem_feed` | Feed | R | `refs[]` | `since` (`30m`/`24h`/`7d`), `limit` (50) | `acmi_cat` |
| `logmem_follow` | Follow | W | `action` ∈ follow·unfollow·list | `ref`, `role`, `agent` | `acmi_active` |
| `logmem_assign` | Assign | W | `job`, `title` | `owner`, `details{}` | `acmi_work_create` |
| `logmem_update` | Update | W | `job`, `summary` | `kind` (progress), `trail`, `origin` | `acmi_work_event` |
| `logmem_stage` | Stage | W | `job`, `stage` ∈ open·active·blocked·done | `note` | `acmi_work_signal` |
| `logmem_open` | Open | R | `job` | `limit` (50) | `acmi_work_get` |
| `logmem_jobs` | Jobs | R | — | `stage` | `acmi_work_list` |
| `logmem_recall` | Recall | R | `query` | `limit` (5) | `acmi_search_semantic` |
| `logmem_remove` | Remove | W (destructive) | `key` | `confirm` (false) | `acmi_delete` |
| `logmem_spaces` | Spaces | R | — | — | `acmi_tenant_list` |
| `logmem_connection` | Connection | R | — | — | `acmi_mcp_status` |

### Result envelope

Every result is `{ ok: boolean, ... }`, returned both as `structuredContent` and as JSON text.
Errors are `{ ok: false, error, tool }` with `isError: true`. Tools never throw across the wire.
If the call triggered shift bookkeeping, the result carries
`shift_events: [{ type: "auto-start" | "auto-recap" | "switch-recap" | "start" | "already-started", agent, shift }]`.

### Behaviour that the schema can't express

- **handoff** writes the same entry (same `trail` and `ts`) to `where` (if given) and to the receiver's agent log. The receiver follows `where` with role `owner`. On a job, `now.owner` becomes the receiver.
- **accepting** a handoff: `logmem_note { where, kind: "accepted", origin: <handoff trail> }`. The entry is mirrored to the acceptor's own log, so their Brief stops listing it under `handoffs_to_me`.
- **ask** writes `kind: approval` with `action`, `reversible` and `status: "waiting"`, then sets the asker's `now.waiting_on`. The asker must not act until an entry with `kind: decided` and `origin = <ask trail>` exists. v0 relies on the agent honouring this rule; the server does not enforce it (see §8, open item O3).
- **stage** writes `stuck` for blocked, `done` for done, and `progress` otherwise.
- **remove** works only inside the connection's space, never on protected keys (`lm:*:registry:*`, `lm:*:session:*`, `lm:oauth:*`). It previews unless `confirm: true`. A successful remove logs a `fix` entry on the remover's agent log.

## 4. Entry shape and kinds

```jsonc
{
  "ts": 1791731538741,        // ms, always
  "kind": "accepted",         // LogMem word (below) or passthrough
  "by": "agent:quill",        // ACMI: source
  "via": "codex",             // surface
  "byline": "quill (via codex)",
  "trail": "...",             // ACMI: correlationId
  "origin": "...",            // ACMI: parentCorrelationId
  "shift": "quillShift-1791731500000",
  "summary": "...",
  "payload": {},              // optional
  "space": "...",             // ACMI: tenant_id, only if supplied
  "speaker": "agent",         // ACMI: speaker_type, only if supplied
  "acmi_kind": "task-delegation" // only when the ACMI input was an alias
}
```

| Group | LogMem word → ACMI primary (aliases) |
|---|---|
| system | started → spawn (session-start) · ping → heartbeat · recap → rollup (pre-compact-snapshot) · joined → onboarding-complete · setup → install |
| handoff | handoff → handoff (task-delegation) · accepted → handoff-ack |
| work | assigned → work-created · progress → work-update · done → work-completed (milestone-shipped) · shared → artifact-published · research → research-brief · checkup → diagnostic-report (audit-report) · feedback → review-note |
| decision | approval → decision-request · decided → decision (decision-ratified) · pivot → scope-decision |
| signal | stuck → stalled-alert · alert → critical-finding · memo → coord-note · huddle → fleet-sync |
| error | problem → incident-update · fix → correction (alignment-fix) |

**Unknown kinds pass through unchanged** in both directions. The live dry run (§7) found 907 distinct
unknown kinds covering 70% of entries (`project-rollup-sync`, `mm-command`, `session`, `research-request`, …).
v0.1 deliberately does **not** grow the dictionary to absorb them. Proposed additions are in §8, item O1.

## 5. Shifts and the persona switch

A **shift** is one agent, on one surface, in one session. Its state is stored at `lm:{space}:session:{sid}` (7-day TTL).

| Event | Rule |
|---|---|
| First call of a session with no open shift | **auto Start**, as `LOGMEM_AGENT`, else the client name, else `guest` |
| Any call more than **30 min** after the last call | **auto Recap** of the old shift (`mode: auto, reason: idle`), then auto Start as the *same* agent |
| No call at all after 30 min (stdio only) | a 60 s sweep timer writes the idle Recap |
| `logmem_start <B>` while A holds the shift | Recap A (`reason: "switch to B"`), end A's shift, Start B, return B's Brief |
| `logmem_start <A>` while A holds it | no-op; `shift_events: already-started` |
| `logmem_recap` | Recap with the agent's own notes (`mode: manual`); ends the shift unless `end: false` |

`logmem start <agent>` is a **phrase people type**. The server instructions tell every model to map it to `logmem_start`.
`logmem_spaces`, `logmem_connection` and every `acmi_*` tool skip shift bookkeeping.
HTTP sessions: `initialize` returns `Mcp-Session-Id: <surface>.<uuid>`, and the surface is parsed back from that id on later stateless calls.

## 6. Server instructions block (works with no skill installed)

Sent in the MCP `initialize` result as `instructions`. The canonical text lives in `src/core/instructions.mjs`.
It is under 2,000 characters and uses no markdown that a host might strip. It was checked for
these hosts: Claude (Desktop, Code, Web), Codex, Grok, and Perplexity. All of them surface server
instructions or tool descriptions to the model. Hosts that ignore `instructions` still get the same
rules from the tool descriptions: Start, Ask, Recap and Remove each carry their own rule.

## 7. Compat mode (`LOGMEM_ACMI_COMPAT=1`)

| | `logmem_*` (always) | `acmi_*` (compat only) |
|---|---|---|
| Tools | 21 | 19, ACMI names and parameters |
| Writes go to | `lm:{space}:*` | `lm:{space}:*`, never `acmi:*` |
| Reads | `lm:*` **merged with** legacy `acmi:{space}:*` | same, returned in ACMI shape |
| Fields | trail/origin/by/space/speaker | correlationId/parentCorrelationId/source/tenant_id/speaker_type |
| Kinds | LogMem words | ACMI kinds (aliases restored exactly via `acmi_kind`) |
| Signals | `now` merges | `acmi_signal` replaces (ACMI semantics) |
| Timestamps | ms on write; ns/µs/s normalised on read | same |
| `acmi_delete` | — | maps an `acmi:` key to its `lm:` twin; never deletes legacy keys |

Conformance: the ACMI suite passes against `LogmemAcmiAdapter` (30/30 on `@madezmedia/acmi@1.2.0`, 35/35 on the local acmi suite).

Key/slot/namespace mapping: [`../KEYS.md`](../KEYS.md).

## 8. Open items (need a decision before G1)

| # | Item | Proposal | Owner |
|---|---|---|---|
| O1 | 907 unknown kinds (70% of live entries) | Leave them as passthrough in v0.1. If Mikey wants the dictionary to grow, add `session → started`, `blocker → stuck`, `research-request/-output → research`, `step-done → progress`. Leave fleet-internal kinds (`mm-command`, `project-rollup-sync`, `wrapper-start`) as they are | mikey |
| O2 | 1,108 live keys have `:` inside the id (`thread:agent-coordination:*` 407, `bus:relay:*` 252, `workspace:madez:*` 152, `library:skill:*` 119 …) | Migration joins the extra segments with `.` (`bus:relay:events:x` → ns `bus`, id `relay.events.x`). The double prefix `agent:agent:<id>` collapses to `agent:<id>` (merge) | claude-engineer → mikey |
| O3 | `ask` is honour-system | v0.2: add a server-side `pending_approval` check that write tools on the same `where` respect, unless `force: true` | claude-code |
| O4 | HTTP session ids are client-supplied | Accept for v0 (same trust boundary as the space). v0.2: sign them (HMAC with a deploy secret) | claude-code |
| O5 | Compat dual-write during fleet cutover | No. Cutover is one config flip per agent; compat reads cover the gap | mikey (cutover is HITL) |
| O6 | 36/36 conformance target in the work item | No 36-test suite exists that I could find; the local suite has 35. Asking claude-cowork for the source | claude-cowork |
