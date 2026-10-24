# Managed client entry update

The homepage and onboarding now lead invited clients into managed workspace access.
Michael approved this correction after the client launch audit.
The existing LogMem design, fonts, logos and business examples stay in use.

## Changes

- Homepage navigation and hero links open the managed setup choice.
- The primary setup card explains login, workspaces, private spaces and the first agent task.
- Managed clients do not need Redis credentials.
- The setup checks customer session availability before opening the app.
- Unavailable managed login shows a retry message instead of opening the operator login.
- Access requests remain separate and skip the terminal probe.
- Advanced users can still test native TLS Redis or an HTTPS bridge.
- The space form uses a business example instead of Field Notes.

## Integration

This branch starts from PR 121 at `3a2c790`.
Merge these changes into the client foundation release before production onboarding.
This work does not depend on PR 123 comments and nudges.
Antigravity retains provider configuration and real identity verification.
OpenCode retains account UI and agent connection recovery.

Keep public signup closed until the real identity checks pass.
These changes do not enable customer flags or create client accounts.

## Verification

Phone and desktop browser checks cover the homepage entry, unavailable login, retry, customer login, access requests and advanced Redis setup.
The existing customer browser checks cover workspace creation, invitations, task creation, signout and space isolation.
All 14 targeted checks passed before the final access request simplification.
The final six entry checks passed after that change.
JavaScript syntax and whitespace checks pass.
Real Clerk login and an actual OAuth connection remain separate release requirements.
