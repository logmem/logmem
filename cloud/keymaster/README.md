# Keymaster

Spec: `docs/superpowers/specs/2026-10-14-secret-handling-design.md`.

## Step 1: one identity per agent (Mikey, in the Infisical UI)

For each agent (`claude-code`, `codex`, `opencode`):

1. Organization → Access Control → Identities → Create. Name: `agent-<id>`. Role: No access.
2. Open the identity → Authentication → Universal Auth → Add. Create a client secret. Copy the Client ID and the
   secret into that agent's host Keychain. Do not paste them into chat.
   ```bash
   security add-generic-password -U -s infisical-agent -a <id> -w
   ```
3. Project `b9e3…` → Access Control → Identities → Add `agent-<id>` with a role that reads `/agents/<id>/` only.
4. Secrets → prod → create folder `/agents/<id>/` and a secret `CANARY` with any dummy value.

## Check it

```bash
INFISICAL_CLIENT_ID=<id from Keychain> INFISICAL_CLIENT_SECRET="$(security find-generic-password -s infisical-agent -a <id> -w)" node scripts/identity-canary.mjs <id>
```

Expected: `{"agent":"<id>","ok":true,"length":<n>}`. The value never prints.

## Daily matrix

Run with the keymaster's own identity:

```bash
node scripts/keymaster-matrix.mjs
```

It writes the access matrix to `Now` on `job:secrets` and an `alert` for each grant that ends within 7 days.
The `/agents/<id>/canary` secret is the only secret any check reads.
