# LogMem secret handling (P0) — design

Status: design approved by Mikey in chat with claude-code, 2026-10-14. Spec in review. Roadmap: `docs/ROADMAP.md`, P0.
Owner: claude-code (spec, keymaster v0, screen Phase 1).

## Why

Today one shared, guessable bridge token reaches every fleet agent's memory, and the bridge accepts EVAL. Mikey pastes
every key by hand. If one agent leaks, we cannot cut it off without cutting off the fleet.

Goals, in order (Mikey's choice D):

1. **Damage control (the P0 bar).** Each agent has its own identity. One step cuts off one agent. A leak exposes only
   what that agent could read.
2. **Less of Mikey in the loop.** An agent requests a secret. Mikey approves with one click. A keymaster agent does the
   rest.
3. **A product feature.** The fleet is the first customer. The same model becomes a LogMem feature.

## Rules that hold everywhere

- No secret value goes into chat, a LogMem or ACMI entry, a signal, a timeline or a screen. Entries carry references:
  the Infisical path and name.
- Agents never paste or type secret values. Values move Infisical → process, or Infisical → proxy.
- Bridge and payment keys always need a LogMem Ask, for every change.

## The parts

### 1. One identity per agent

- An Infisical machine identity per agent, named `agent-<id>` (`agent-bentley-main`, `agent-codex`).
- Default read scope: its own folder, `/agents/<id>/`. Other folders only by a grant with a time limit.
- Its login credentials live on its host: Keychain on the Mac, a 0600 file or container env on a VM. Never in chat
  or LogMem.
- Mikey creates each identity in the Infisical UI. Creating one mints a credential, so it stays a human click. The
  keymaster writes the exact steps.

### 2. The keymaster agent (`agent:keymaster`)

A Claude Code subagent with one job: Infisical. Its tools are the Infisical CLI and API only. It runs no other agent's
task. It has its own identity, which can manage identities, roles and secrets, and cannot grant access to itself.

| Acts on its own | Asks Mikey first (`logmem_ask`) |
|---|---|
| Revoke a grant | Create a secret |
| Expire a session | Grant an agent access |
| Scheduled rotation (non-payment, non-bridge) | Any change to a payment or bridge key |
| Flag stale grants and keys | |

Revoke and rotate only take access away, so they run fast. Grant is the risky direction, so it waits for a person.

### 3. Two ways to deliver a secret (Mikey's choice C)

- **Proxy (Infisical Agent Vault)** for HTTP API keys (Stripe, OpenAI, 21st.dev). The agent sends the placeholder
  `agent-vault`. The proxy adds the real key on the way out. The agent never holds the key. Kit:
  `~/clawd/fleet/agent-vault`. This tier waits until our Infisical license is confirmed to include Agent Vault.
- **Service account** for everything else (database URLs, the bridge token). The agent loads values at startup with
  its own identity.

Every agent gets an identity in both tiers. The identity is the off switch.

### 4. Request flow

1. The agent calls `logmem_ask` with `{secret: "/shared/stripe/STRIPE_KEY", for: "agent-codex", scope: "read",
   ttl: "30d"}`.
2. Mikey approves or rejects on the screen.
3. Approve: the keymaster applies the grant in Infisical with the time limit and writes `granted` with the Ask trail.
4. Reject: nothing changes. The requesting agent sees the answer in its next Brief.

### 5. The screen (Mikey's choice C)

- **Phase 1 (this week):** a generative-UI artifact over `job:secrets`. Pending requests, an access matrix (agent ×
  secret), last rotated, expiry, and Revoke buttons. An Approve click is a LogMem decision.
- **Phase 2:** a Secrets page and Asks in the LogMem admin, for customers, on the same data.
- Both show names, scopes and dates. Never values.

### 6. Guard rails

- LogMem refuses entries that look like secret values (the write-path guard in `src/core/tools.mjs`, bentley-main's
  lane).
- The keymaster cannot grant to its own identity.
- No fallback to a shared token, ever.

## Data

### Infisical folders (project `b9e3…`, env prod)

| Folder | Who reads it |
|---|---|
| `/agents/<id>/` | That agent's identity |
| `/shared/<service>/` | Agents with a grant (time-limited) |
| `/fleet-shared/acmi` | Bridge consumers, by grant; changes always behind an Ask |
| `/keymaster/` | The keymaster and Mikey |

### LogMem

- `job:secrets` is the keymaster's log. Entry kinds: `progress` for `granted`, `revoked`, `rotated`, `expired`;
  `alert` for `stale`; `stuck` and `problem` for failures.
- Each entry payload: `{secret_ref, agent, scope, ttl, expires_at, ask_trail}`. `secret_ref` is the path and name only.
- `Now` on `job:secrets` holds the current access matrix. The Phase 1 screen reads it.

## Rollout (each step stands alone and can be undone)

| Step | What | Done when | Priority |
|---|---|---|---|
| 1 | Identities for claude-code, codex, opencode | Each fetches `/agents/<id>/canary` with its own identity | P0 |
| 2 | Keymaster v0, read-only: daily access matrix to `job:secrets` | Matrix in `Now`, no values anywhere | P0 |
| 3 | Screen Phase 1 | Mikey sees the matrix and pending requests | P0 |
| 4 | Asks live: grants on approve, revokes on its own | One real grant approved, one revoke run alone | P0 |
| 5 | VM agents get identities (bentley-main with the keymaster) | Each VM agent fetches its canary | P1 |
| 6 | Bridge rotation through identities | Consumers read the new token by identity; old token retired | P1 |
| 7 | Agent Vault proxy tier | One HTTP key served by placeholder | P1 |
| 8 | Secrets page in the LogMem product | Customer can see and revoke grants | P2 |

**P0 is done** when steps 1–4 are live for the three Mac agents.

## Failure handling

- Infisical down: agents keep the values they loaded. The keymaster writes `stuck`. No fallback to a shared token.
- A grant fails after approve: the keymaster writes `problem` with the Ask trail. The Ask stays open.
- Suspected leak: one revoke on the agent's identity. The keymaster then rotates each secret that identity could read.
  Bridge and payment rotations need an Ask.

## Testing

- Each step's done check uses a dummy secret, `/agents/<id>/canary`. Never a real one.
- Write-guard tests feed fake keys (AWS-, Stripe-, GitHub-shaped) and check that LogMem refuses them.
- The screen gets a check that no field renders a value from Infisical.

## Owners

| Part | Owner |
|---|---|
| Spec, roadmap, keymaster v0, screen Phase 1, bridge rotation (lock exception `bridgeTokenLockException-20261014`) | claude-code |
| Creating identities in Infisical | Mikey |
| VM agent identities | bentley-main with the keymaster |
| LogMem write-path secret guard | bentley-main |
| Secrets page in the product | assigned later |

## Not in this design

- **Invite-only signup on the Infisical server.** The server reports `inviteOnlySignup: false`, so anyone can register.
  Mikey turns it on in the admin console (Server Admin → General). It is the cheapest fix and needs no code.
- Multi-tenant customer vaults and hardware keys.
