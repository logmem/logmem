# Approved dashboard cockpit

Michael approved the interactive cockpit layout and requested its HTML implementation.
White is the default. Sage, Sand and Midnight remain optional themes.
Keep LogMem fonts, real logos and semantic colors. Primary actions use neutral ink.

## Scope

Implement the existing HTML and Lit dashboard. Keep backend contracts and permissions.
Use Today, Inbox, Work, Team, Knowledge and Health as the main destinations.
Keep Activity, source threads, agent keys and settings reachable.
Today emphasizes real priorities and source coverage. Inbox reuses the existing coordination queue.
Knowledge exposes real decisions and discussions. Health exposes existing Audit and daily receipt data.
A contextual assistant rail provides source navigation. It states that AI execution is not configured.
Do not introduce model calls, fake usage, fake proposals or unverified runner controls.

## Acceptance

Navigation works at desktop and phone sizes. Themes persist locally and default to White.
Source comments, nudges and existing authorized actions keep working.
Unknown coverage, usage and runner status stay explicit.
The client access gate remains unchanged.

## Follow-on

Plan an incremental Next.js App Router build on Vercel with shared LogMem primitives.
Keep customer tenancy, credentials and long-lived agent execution on existing server boundaries.
Coordinate design parity, provider readiness, authorization and deployment ownership with the fleet.
