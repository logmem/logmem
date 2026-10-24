# LogMem signup and shared workspace design

Status: Approved by Michael Shaw on 2026-10-23
Date: 2026-10-23

Let people sign up, create a workspace, and create private spaces inside it.
Keep the dashboard centered on the selected space and its next actions.

## Current code

The reviewed checkout has Clerk authentication for managed connections.
It creates one managed account and one space per Clerk user.
Account creation uses an invite gate unless LOGMEM_SIGNUP_OPEN is enabled.
Managed MCP calls use storage guards tied to that one space.

The dashboard uses a separate operator password.
Its space list comes from deployment configuration.
Human actions use an operator identity.
This does not provide customer signup, workspace membership, or customer-created dashboard spaces.

Reviewed files:

- src/http/accounts.mjs
- src/http/clerk.mjs
- src/http/jail.mjs
- src/http/admin-auth.mjs
- api/login.mjs
- api/view.mjs
- public/app/main.js
- public/app/shell.js

These findings describe the reviewed code, not a new production configuration audit.

## Approach choices

| Approach | Benefit | Cost |
| --- | --- | --- |
| Workspace with several spaces | Clear business boundary, team membership, shared administration | Requires workspace and space authorization |
| Each space is a separate tenant | Smaller initial data model | Repeats membership and complicates business administration |
| Personal accounts with shared links | Quick prototype | Poor fit for teams, revocation, and private business data |

Recommend the first approach.
A solo operator can use one workspace and one space.
A business can add spaces without creating another login.

## Domain shape

User is a verified human identity.
Workspace is the tenant and future billing boundary.
Space is a private work boundary inside a workspace.
Workspace membership grants a business role.
Space membership grants access to a particular space.

A user can own or join several workspaces.
A workspace can hold several spaces.
Tasks, jobs, plans, decisions, comments, handoffs, and roundtables belong to one space.
Agents and connections receive explicit space grants.
Calendar items and artifacts retain their source space.

Use immutable internal IDs.
Names and URL slugs are display and routing values, never proof of access.
Do not encode new space ownership by parsing a display name.

## Signup journey

1. Select Get started on the homepage.
2. Complete signup through the existing Clerk integration and verify the account.
3. Enter a workspace name and an optional business type.
4. Name the first space.
5. Create both records with the user as owner.
6. Open Today in that space.
7. Offer Add a task, Connect an agent, and Invite a person.

Business type selects optional starter content.
Offer solo operators, developers, trades, restaurants, and sales teams.
Sample content remains visibly labeled and cannot trigger connected services.
The user can skip business type, samples, invitations, and agent connections.
The first useful action must not require an agent credential.

Retrying workspace creation must recover the same successful result.
A failed creation must not expose a partial workspace.
An existing user returns to their last accessible space.
An invitation accepts membership without creating an unwanted extra workspace.

## Dashboard shape

Keep Today, Work, Agents, and Activity.
Put the workspace and space switcher at the top of the navigation.
Show readable space names and a clear Create space action.
Keep workspace settings separate from space settings.

Today shows waiting human decisions, unanswered handoffs, overdue work, and upcoming commitments in the selected space.
An empty space shows the three first actions instead of blank charts.
Record panels keep Context, Discussion, History, and Linked work.
Comments and Send to agent remain separate actions.

Keep initial search, inbox, calendars, and counts scoped to the selected space.
A later workspace overview can combine authorized spaces with visible source labels.
Switching spaces clears cached records, pending panels, and subscriptions before loading the next space.
Late responses from the previous space must never render in the new space.

## Permissions

| Role | Initial powers |
| --- | --- |
| Workspace owner | Manage workspace, owners, members, spaces, connections, and approval rights |
| Workspace admin | Manage members, spaces, and connections, except ownership transfer and workspace deletion |
| Workspace member | Enter explicitly granted spaces and create spaces within workspace policy |
| Workspace viewer | Read explicitly granted spaces |

Owners and admins have access to workspace spaces for administration.
Members and viewers require explicit space grants.
Within a space, editor access permits work updates and comments.
Viewer access permits reads only.
Approval authority is explicit and separate from general editing access.
Creators receive approval authority for their initial space.

Only owners and admins can invite workspace members in the first release.
Invitations expire after seven days and bind to a verified email identity.
Users see the workspace, space grants, and role before accepting.
Revoked or expired invitations cannot create membership.
The last owner cannot leave or lose ownership without transferring ownership first.

## Server boundary

Reuse Clerk for human identity.
Keep membership and space authorization in LogMem.
Do not use the shared dashboard password for customer sessions.
Keep operator administration on a separate explicit path.

Each request must resolve the verified user, active workspace membership, requested space, action permission, and storage context.
Never trust a workspace ID, space selector, request body identity, or cached role on its own.
Apply this to views, writes, search, exports, live updates, approvals, keys, and connection management.
Tenant filtering must happen before results, counts, or event streams reach the browser.

Keep existing namespaces intact during migration.
Add authoritative ownership mappings for spaces instead of renaming all stored records.
Extend the storage guard for an authorized space under its verified tenant.
Do not weaken the current jail into a broad caller-selected namespace.
Usage limits aggregate at the workspace while keeping space attribution.

Agent credentials bind to workspace, space grants, agent identity, and allowed actions.
Existing single-space credentials keep their original scope.
Adding a dashboard space does not silently grant agent access.
Disconnected credentials and removed memberships lose access on subsequent requests.
Browser sessions and live streams must handle revocation without retaining readable stale data.

## Service surface

Provide authenticated endpoints for current user context, workspaces, spaces, memberships, and invitations.
The current-user response lists only authorized workspaces and spaces.
Workspace and space creation use idempotency keys and enforce server limits.
Membership changes and invitations leave an audit record.
Human decisions record the verified user's identity and exact approved action.
Keep existing MCP OAuth separate from browser login.

Public signup requires bounded workspace creation, space creation, invitations, and authentication attempts.
Reuse existing quota infrastructure where possible.
Start with finite configurable limits and explicit errors before opening signup.
Do not require payment details or enable paid autonomous work during signup.

## Delivery order

1. Add workspace, space, and membership records with isolation tests and migration fixtures.
2. Extend authorized storage resolution while preserving existing single-space agent grants.
3. Add customer dashboard sessions and user context across every dashboard endpoint.
4. Add idempotent workspace and space creation, switching, and useful empty states.
5. Add invitations, roles, membership removal, and approval rights.
6. Verify migration, isolation, quotas, and signup in preview before enabling public signup.

Keep handoff semantics and the existing pending-index ownership unchanged.
ACP, OpenDots, Harness², and Jev integrations follow this identity and space foundation.

## Required verification

Test two tenants, two spaces within one tenant, and a user who belongs to both tenants.
Try direct foreign IDs against all read, write, search, stream, export, and connection endpoints.
Test a user allowed into one space but refused access to its sibling.
Check that errors and counts do not reveal foreign records.
Verify role downgrade, revoked membership, expired invitation, and agent key revocation.
Verify simultaneous creation, retries, quota enforcement, and last-owner protection.
Verify browser back, multiple tabs, sign out, mobile switching, and late responses.
Verify OAuth reconnect preserves the selected authorized space and agent identity.
Run existing account, OAuth, jail, tenant, dashboard, and conformance checks.

## Acceptance

A new user can sign up and create a named workspace and first space.
They can create another space and switch between both.
An invited teammate sees only granted spaces.
An unrelated account cannot read or change their records through any dashboard or agent endpoint.
Existing fleet spaces and agent connections retain their data and scope.
No customer action requires the operator password.

## Review state

Michael Shaw approved these product and security boundaries.
Implementation has not started.
Public signup and production settings remain unchanged.
