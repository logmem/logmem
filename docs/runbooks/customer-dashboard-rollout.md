# Customer dashboard rollout

Keep public signup closed until customer isolation and real identity checks pass.

## Controls

- `LOGMEM_CUSTOMER_DASHBOARD=1` enables customer browser APIs and the customer dashboard entry.
- Unset that flag to keep the current operator dashboard.
- `LOGMEM_SIGNUP_OPEN=1` opens account creation. Keep it unset during invite-only preview testing.
- Clerk keys and `LOGMEM_CUSTOMER_REDIS_URI` must be configured on the server.
- `LOGMEM_OAUTH_KEK` and the existing OAuth issuer configuration remain required for OAuth connections.
- Existing operator access stays available at `/app?operator=1` with its existing operator password.
- Customer identities never gain operator rights through workspace ownership.

## Before rollout

1. Run `npm run ci`, `npm run test:e2e`, and `git diff --check`.
2. Review the full branch for authorization, token scope, tenant boundaries, and migration safety.
3. Deploy a protected preview with customer dashboard enabled and signup closed.
4. Invite two real test identities through the existing beta invite mechanism.
5. Create separate workspaces. Verify that each identity cannot open the other's records or direct API IDs.
6. Add two spaces to one workspace and grant a teammate only one space.
7. Check role downgrade, removal, invitation expiry, signout, and two-tab behavior.
8. Connect a test agent through OAuth. Verify the selected workspace and space on consent and after reconnect.
9. Revoke a connection and remove its issuing manager. Existing grants must stop working.
10. Check both phone and desktop flows, including failed creation retries and slow space switching.

Synthetic browser tests do not replace these provider checks.
Record real results before enabling public signup.

## Existing accounts

Run `node scripts/workspace-migrate.mjs --dry-run` against the intended customer storage.
Inspect tenant IDs and proposed actions.
Run with `--apply` only for that verified environment.
The command adds workspace metadata and membership indexes.
It never renames namespaces or changes agent tokens.
It skips paused tenants and inconsistent account ownership.

## Rollback

Unset `LOGMEM_CUSTOMER_DASHBOARD` and `LOGMEM_SIGNUP_OPEN`.
Redeploy the previous verified release if required.
Do not delete workspace, space, membership, or token records during rollback.
Existing agent credentials retain their original scope.
Reopening the customer dashboard reuses the same IDs and data.

## Operational limits

Initial limits are three owned workspaces, ten spaces per workspace, one hundred membership records, and twenty active agent keys.
Agent key creation allows twenty keys per actor per hour. Revocation removes the key from active metadata and deletes its lookup.
Invitation creation allows twenty requests per actor per hour and fifty pending invitations per workspace.
Invitation metadata keeps at most one hundred unexpired records.
Control audit storage keeps the latest five thousand events. The workspace record keeps the latest one hundred events.
Idempotency records expire after seven days.
Invitations expire after seven days.
No signup flow starts paid model calls, computer services, or recurring agent runs.

## Current verification state

Implementation checks are recorded with the pull request.
Production customer signup is not enabled by this branch.
Live Clerk test identities, real OAuth reconnect, and preview configuration still require environment evidence.
