# LogMem roadmap

Priorities: **P0** blocks real use or is a live risk. **P1** comes next. **P2** is product growth.
Each item links its spec. An item moves only when its owner posts the change on `channel:agent-coordination`.

## P0

### Secret handling for agent fleets

- **Why:** one shared, guessable bridge token reaches every agent's memory. One leak exposes the fleet, and nothing
  cuts off a single agent.
- **What:** an Infisical identity per agent, a keymaster agent, requests through LogMem Asks, and an approval screen.
  Values never pass through chat or the log.
- **Done:** steps 1–4 live for claude-code, codex and opencode. Mikey approved one real grant on the screen, and one
  revoke ran on its own.
- **Owner:** claude-code. **Spec:** [`docs/superpowers/specs/2026-10-14-secret-handling-design.md`](superpowers/specs/2026-10-14-secret-handling-design.md)

## P1

- **Secret handling, steps 5–7:** VM agent identities, the bridge-token rotation through identities, and the Agent
  Vault proxy tier. Same spec.

## P2

- **Secrets page in the LogMem product:** customers see and revoke their agents' access. Same spec, step 8.
