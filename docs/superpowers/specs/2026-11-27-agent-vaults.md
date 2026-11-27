# Agent Vault — fleet spec

- **Date:** 2026-11-27
- **Status:** build started; this doc is the source of truth for the rollout
- **Owner:** opencode · **GO:** Mikey ("spec it out, let's build agent vaults")
- **Source material:** `~/clawd/fleet/agent-vault/README.md` (bentley-main's Oct12 plan), `WALKTHROUGH-OPENCLAW-HERMES-2026-11-13.md` §5

## 1. Problem and goal

CLI agents on this Mac (opencode, claude-code) currently ride a **shared Infisical user session** — full read and write, every path. The canonical ruling (`infisical-secrets` skill, 2026-10-25) wants least scope per consumer.

**Goal:** agents hold **no long-lived credentials**. An Agent Vault proxy attaches the real credential at the network boundary. If an agent is compromised, the attacker gets an expiring session token, not our keys.

## 2. Architecture (verified inventory, 2026-11-27)

| Piece | Value |
|---|---|
| Instance | self-hosted Infisical `https://infisical-u70402.vm.elestio.app` (build v0.167.6) |
| Project | **Agent Vault** `d1b200ab-b9e5-4a4e-a4de-2d875a69c119` (auto-created per org; Mikey = admin, `open-code` = admin, `agent-claude-code` + `agent-codex` = members) |
| Bundle | **`onboarding`** (`bec4a1f9…`) → service **`anthropic-api`** (`api.anthropic.com`, bearer = box Anthropic key) |
| Proxy | **`opencode-local`** (`a9027f66…`), policy `bundle-hosts`, poll 30s, CA `SHA256:1A:AD:14:E6:…` |
| Kit | `~/clawd/fleet/agent-vault/` — `README.md`, `av-run`, `av-check`, `av-ca`, `av-proxy-start.sh` |
| Keychain | service `agent-vault`, account = agent-id (`claude-code`, `opencode`, …) |
| Session TTL | 12h (renew by re-minting, see backlog) |

## 3. How an agent runs (the pattern)

1. **Mint** a session over the bundle:
   `infisical agent-vault sessions create --access-bundle onboarding --ttl 12h --project-id d1b200ab-… -o json`
   Capture the token to a 600 file. Never argv, never chat, never git.
2. **Store** it in the Keychain:
   `security add-generic-password -U -s agent-vault -a <agent-id> -w`
   with the token on stdin **twice** (data + retype prompts). Value never in argv.
3. **Run** through the kit: `av-run <agent-id> <command>` reads the Keychain token, exports `HTTPS_PROXY` with the placeholder `agent-vault`, and sets the CA env.
4. The **proxy** swaps in the real credential per host per bundle policy on the way out.
5. **Revoke:** `infisical agent-vault sessions revoke <session-id> --project-id …`.

## 4. Enrollment state (built 2026-11-27)

| Identity | Keychain | Proof |
|---|---|---|
| `opencode` | stored, read-back verified | `av-check` → HTTP 200, proxy log `decision: brokered` |
| `claude-code` | stored, read-back verified | `av-check` → HTTP 200, proxy log `decision: brokered` |

Notes:
- claude's Nov14 enrollment never completed (no Keychain token existed); fixed today.
- The first mint attempt produced two sessions that were never stored; they were not kept anywhere and expire within their TTL.

## 5. Proof method

```bash
~/clawd/fleet/agent-vault/av-check <agent-id> https://api.anthropic.com/v1/models
# → HTTP 200, proxy log: {"decision":"brokered","service":"anthropic-api","accessBundle":"onboarding"}
```

- `/v1/*` requires the `anthropic-version` header; a bare curl gets an Anthropic 400. That is **not** a proxy failure. The kit sends it as of 2026-11-27.
- Hosts not covered by the bundle are **blocked 403** by policy (`no service covers host …`) — working as designed.

## 6. Persistence (built 2026-11-27)

The proxy previously ran as a `nohup` process with its data-dir and log in purgeable temp — a reboot or temp purge lost it with no restart path.

Now:
- **launchd agent:** `~/Library/LaunchAgents/ai.infisical.agent-vault-proxy.plist` → `~/clawd/fleet/agent-vault/av-proxy-start.sh` (`RunAtLoad`, `KeepAlive`).
- **Token:** fetched server-side at start from Infisical prod `/fleet/clients/agent-vault` → `AV_PROXY_TOKEN`, with a **600-file fallback** `~/.config/agent-vault/proxy-token` (the launchd environment cannot read the CLI's Keychain login). The token is in neither the plist nor the wrapper.
- **Data:** `~/Library/Application Support/agent-vault` · **Log:** `~/Library/Logs/agent-vault-proxy.log`.
- **Rebind command** (kickstart hangs on this build): `launchctl bootout gui/501/ai.infisical.agent-vault-proxy` then `launchctl bootstrap gui/501 <plist>`.
- Same proxy id (`a9027f66…`); settings and CA re-fetched from Infisical at start. Old nohup process stopped.

## 7. Backlog (ordered)

1. **Session renewal** — 12h TTL: a renew job (re-mint + Keychain update, silent) on a launchd timer, or negotiate a longer TTL.
2. **Bundle coverage** — add services per consumer (GitHub for the daily-driver, Upstash, …). Each service added here replaces one long-lived token from the three-credential revoke job (`leaked-credentials-revoke-20261127`).
3. **Claude tightening completion** — claude's brokered path works; next it moves its secrets reads to `av-run`, then `Bash(infisical login *)` leaves its allowlist (handoff to claude).
4. **Cloud tasks (fleet-driver)** — a cloud scheduled task cannot reach `127.0.0.1`. Needs the proxy on a reachable host (fleet box / VM) plus a network path, or fleet-driver stays key-based until then.
5. **More identities** — bentley, codex, fleet-driver as they onboard (mint over the right bundle).
6. **SSH services** — not in this Infisical build (v0.167.6); SSH stays on PAM until an instance upgrade.
7. **Mikey's README items** — invite-only sign-up, Agent Vault license verification (README §0).

## 8. Relation to the canonical method

- `infisical-secrets` SKILL.md stays canonical for **storage and delivery**: where secrets live, read-only scoped service tokens, out-of-band delivery.
- Agent Vault is the **runtime access layer** for agent processes: an expiring session token replaces the long-lived credential, and the proxy holds the real one.
- Service tokens remain for consumers that cannot reach a proxy (Vercel, boxes, scripts) until they can.
