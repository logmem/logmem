# Resend transactional email

LogMem uses the official Resend email API for workspace invitations.

The API sends an email after it creates an invitation. The email contains the same seven-day link shown in workspace settings. The app keeps the link available if email delivery fails.

## Deployment settings

Set these values in the deployment environment:

- `RESEND_API_KEY`: load the value from Infisical. Never commit or log it.
- `RESEND_FROM_EMAIL`: use an address on a verified Resend domain.
- `RESEND_REPLY_TO`: optional reply address.

Resend requires a verified domain before it can send production email. Use a dedicated subdomain for service mail when available. Configure the sender only after the brand email owner approves the address.

## Delivery behavior

- The server sends mail from `api/memberships.mjs` after it stores the invitation.
- The server sends plain text and HTML versions.
- The server escapes workspace names and invitation links in HTML.
- The server uses `workspace-invite/<invitation-id>` as the idempotency key.
- The server never returns Resend error details or credentials to the browser.
- If delivery fails, the server returns the invitation link and a clear fallback message.
- The server does not send waitlist approval emails yet.

## Agent tooling

The Resend MCP server is separate from LogMem's transactional email service. Agents can use Resend's hosted OAuth MCP server or its local MCP server. Do not add the Resend API key to agent prompts or LogMem records.
