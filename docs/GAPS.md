# LogMem gap review (2026-10-11)

Four parallel read-only reviews (security, architecture and scale, product completeness, operations) of
`feat/site-pass-a` after pass A went live on logmem.si, plus a homepage comparison with mem0.ai.
Findings were spot-checked before acting. Already fixed in `fix(security)` (deployed): stored XSS on Audit and
the scorecard, the open-relay/SSRF via raw creds on production, CSP and framing headers, scorecard space allowlist,
`.vercelignore`.

## Decision integrity follow-up (2026-10-12)

Independent review `logmemPr10Review-20261012d` of the decision-integrity work merged in PR #10.
Fixed on this branch. Do not treat a `decided` row as an answer unless its signature verifies against the ask.

| # | Gap | Fix |
|---|---|---|
| H1 | The decision HMAC did not bind the ask, so a store writer could swap the question or flip `reversible` under a valid signature. `findAsk` could also accept a shadow copy of the same trail on another agent's log. | **Fixed.** Signature v2 covers action, question, reversible, to, where, trail, and by. `verifyDecision` fails when the live ask differs. `findAsk` reads agents in id order, keeps the earliest copy on the asker's own log, and refuses shadows and conflicting copies (`ambiguous`). |
| H2 | `acmi_delete` / `logmem_remove` could delete another agent's who/log/profile. `acmi_event` could append to another agent's log. `logmem_note`, `acmi_event`, and `logmem_update` could write `accepted` or declined feedback and settle a handoff. Deleting a log dropped the signed `decided` row. | **Fixed.** Removal of another agent's who/log/profile is refused. A log that holds a signed decision is never removed. `acmi_event` is own-agent. Only `logmem_accept` (including decline) writes those settlement rows. Readers also settle from the decision key when its signature verifies, so a missing log row does not reopen the ask. |
| M1 | The job page closed ask cards from unsigned `decided` rows and from deferrals. | **Fixed.** The page renders `open_asks` computed with the same rule as the Brief. Unverified `decided` rows stay in the log and are marked unverified. |
| M2 | A crash after `SET NX`, or a `LOGMEM_DECIDE_SECRET` rotation, left an ask stuck. | **Fixed.** Entries are appended first; the key is claimed only after every append succeeds, and a failed append rolls those entries back. An admin re-answer from the Decisions page replaces a key whose signature does not verify under the current secret. A key that still verifies against the ask that was signed, but not against the ask as it reads now, is not replaced. |
| L1 | A resumed shift trusted a caller-tampered agent id, and a caller-chosen trail could collide with one already on the receiver. | **Fixed.** An invalid stored agent id is dropped (not recapped). Handoff and inbox refuse a trail that is already used on that agent's log. |

## Tier 0: fix before anyone else uses it (safety)

| # | Gap | Evidence | Fix |
|---|---|---|---|
| S1 | **The fleet bridge token is a guessable constant** (`vm-local-bridge`), and the bridge URL is public. Anyone can read and write the whole fleet Redis directly, not only through LogMem | confirmed: production env value; `reference/*`, PHASE2-KIT | Rotate to a random token and restrict the bridge by source. **HITL (fleet infra)** |
| S2 | **Approvals can be forged.** Any agent can write `decided`, and `by` is self-asserted, so an agent can approve its own irreversible action | `tools.mjs` note, `instructions.mjs:14`, `view.mjs` decisions | Server-only `decided`, written by an authenticated human endpoint with `verdict`; agents can't write that kind. **Done (T0-b + PR #8 review):** HMAC-signed, set-once (`SET NX`) decisions that fail closed without `LOGMEM_DECIDE_SECRET`; receiver-only; confirm for irreversible; compat `by` from the shift. **Follow-up (2026-10-12):** the signature also binds the ask; see the table above |
| S3 | OAuth stores users' Redis creds **plaintext under the raw token**, possibly in the shared Redis | `api/oauth/_lib/storage.mjs:117` | `sha256(token)` keys, AES-GCM envelope (KEK env), a dedicated deploy Redis with no fallback |
| S4 | No rate limits: login, OAuth register (unbounded, no TTL), MCP | `login.mjs`, `register.mjs` | Vercel Firewall rules; caps and TTL on client records |
| S5 | SSRF via the OAuth consent probes (any host and port) | `authorize.mjs:205-240` | Require `https`/`rediss`, block private IPs after DNS, generic errors |
| S6 | Open redirect, GET-then-DEL token replay, non-constant-time compares | `authorize.mjs`, `storage.mjs`, `token.mjs` | Validate the client first, GETDEL, `timingSafeEqual` |
| S7 | Entries are an unmarked prompt-injection channel (inbox, notes shown in Briefs) | `api/inbox`, Brief | Size caps; mark entry text as untrusted data in instructions and Briefs |

## Tier 1: decide now (expensive to change later)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Entry identity | ULID `id` + `v` schema version + a per-log sequence (`INCR`), replacing member-is-JSON + `_o` + check-then-write dedupe |
| D2 | Atomic write path | One Lua script for append, handoff fan-out and shift transitions; the runner supports scripts and pipelines on both REST and TCP |
| D3 | Contract v1 | Add `cursor`/`next_cursor`, `limit`, `id`/idempotency keys and `verdict`; add `logmem_accept` and `logmem_decide` (human-only); validate `to` against the roster; bump `SERVER_INFO` to the contract version |
| D4 | Hosted layout | Redis = hot store per space (`lm:{space}` hash tag, no global SCAN) + Postgres/object storage for history, search and export. Space registry (owner, plan, backend, retention, quotas) |
| D5 | Retention and ACMI sunset | A hot window per plan with archive; a date to remove compat full-scans and the mirror |

## Tier 2: make it usable (v1)

| # | Gap | Fix |
|---|---|---|
| U1 | No installable package (`@logmem/mcp` unpublished) | Publish after the trademark knockout, or use a `npx github:` path; snippets match |
| U2 | Onboarding is simulated | A real probe (reuse `bridge-probe`), then poll for the first `started` |
| U3 | Humans can't answer decisions | Approve/Reject in /app → `decided` with `verdict`; asker's Brief shows answered asks; clear `waiting_on` |
| U4 | No notifications | One webhook per space (Slack/Mattermost/email) on approval, stuck, and handoffs unanswered for 24h |
| U5 | Auto-Recap misses work written to jobs and channels | Index entries by shift |
| U6 | Open handoffs and asks age out of view (200/500 caps) | An open-items index set per space |
| U7 | One admin password | Accounts (magic link) with per-space roles: owner, approver, viewer |
| U8 | Every read loads whole ZSETs; overview and recall scan | `ZRANGE … REV LIMIT`; a per-space activity ZSET; a search index (RediSearch/Postgres FTS, later embeddings) |

## Tier 3: run it like a service

| # | Gap | Fix |
|---|---|---|
| O1 | No CI gate; prod deploys from a feature branch; `main` is 15 commits behind | `ci.yml` on PRs (`npm test`, `spec:check`), required; merge to main; prod deploys only from main |
| O2 | No timeouts on bridge fetches | `AbortSignal.timeout(5000)`; retry idempotent reads once |
| O3 | No backups or restore | Nightly RDB to off-box storage; AOF; a monthly restore drill |
| O4 | No health check, logs or metrics | `/api/health` (PING + version/SHA); structured request logs; a log drain; SLO 99.5% / p95 < 1.5 s |
| O5 | Silent data loss in stdio degraded mode | Re-probe, spool to disk, or `LOGMEM_REQUIRE_BACKEND=1` |
| O6 | Node and dependency drift | Node 22 pinned, exact SDK version, Dependabot |
| O7 | No runbook | `docs/RUNBOOK.md`: rollback, bridge down, restore, token compromise |

## Tier 4: product and site

| # | Gap | Fix |
|---|---|---|
| P1 | The homepage is static and text-heavy next to mem0.ai | A code-first hero with a tabbed "connect in 30 s" block; a live animated Start → Handoff → Ask → Recap demo; real proof (open protocol, conformance, 36k+ entries running our fleet); use cases (solo multi-agent, team plus approver, agency per client); a trust section (your Redis, every write attributed, approvals); docs, changelog, status |
| P2 | No docs site | Quickstart, tool reference generated from `tools.schema.json`, concepts, self-hosting |
| P3 | No export or delete | `/api/export` JSONL; delete space and revoke agent with typed confirmation |
| P4 | Billing and plans; hosted spaces | After D4 |
| P5 | Semantic recall; approve from Slack | After U8 and U4 |
