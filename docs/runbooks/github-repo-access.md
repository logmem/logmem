# GitHub Repository Access & PR Executor Runbook

Establish and verify the canonical GitHub Pull Request executor path for `logmem/logmem`.

## Overview

When individual agents run in isolated sandboxes or environments where GitHub branch creation returns 403 or network access is restricted, the fleet uses a single, verified **Shared PR Executor** (`agent:antigravity`).

The executor:
1. Validates org-scoped repository push/admin permissions using the non-secret preflight script.
2. Synchronizes upstream `main`.
3. Creates the feature branch, applies changes, and verifies the full test suite (`npm test`).
4. Pushes the branch and creates the Pull Request on `logmem/logmem`.
5. Enforces P0 Production Safety: PRs require independent second-agent review (Codex, Claude, or human maintainer). No self-merging and no auto-deployment.

## Verification: Non-Secret Preflight

Before any agent or automation creates branches or attempts remote writes, run the preflight script:

```bash
./scripts/repo-access-preflight.sh [target-repo]
```

Default target is `logmem/logmem`.

The preflight verifies:
1. `gh` GitHub CLI is installed and available in `PATH`.
2. Active authentication via `gh auth status` (or environment `GH_TOKEN`).
3. Repository access and write/admin permissions via `gh api repos/<target>`.
4. Remote network connectivity via `git ls-remote <target-url> HEAD`.

Exit 0 indicates verified write access. Any failure prints a clean diagnostic without exposing secret tokens.

## Process Controls (P0 Safety)

1. **No Secret Leaks**:
   - Never print tokens (`GH_TOKEN`, PATs, App keys) in chat, logs, or command outputs.
   - Infisical or environment variables should supply credentials securely.

2. **No Self-Merge & No Self-Review**:
   - A PR authored by an agent must be independently reviewed and approved by a second agent or human maintainer before merging.
   - The executor never merges its own PRs.

3. **Separate Merge and Deploy Approvals**:
   - Merging to `main` and deploying to production (`https://logmem.si`) require separate, explicit human/operator decisions.
   - Deploys must pass the canonical release gate (`npm run release:check` / `npm run release:prod`).

## Agent Handoff Flow

When another fleet agent (e.g., Codex or OpenCode) finishes local code changes:
1. Verify local diff and syntax checks (`bash -n`, `npm test`).
2. Log local branch or commit in LogMem.
3. Pass a handoff entry to `agent:antigravity` citing the work item and target files.
4. `agent:antigravity` runs the preflight, pushes the branch, opens the PR, and broadcasts the PR link to `channel:agent-coordination` for independent review.
