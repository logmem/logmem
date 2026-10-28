# Health and agent launch implementation

Michael requested a compact Health command view, AI discovery files and a skills-first client path.
He also requested a three-step first-run launchpad with persistent progress.
This branch builds on the existing Activity and assistant PR 177.

## Health

- [x] Add local queue filters for All, Overdue and Not indexed.
- [x] Keep loaded counts distinct from reported totals.
- [x] Render compact handoff disclosures with unchanged review rights.
- [x] Add per-day audit breakdowns and distinguish volume gates from health signals.
- [x] Reuse the source-aware assistant and read-only grant inspector.
- [x] Verify desktop, phone and four-theme layouts.

## Public discovery and client entry

- [x] Verify robots.txt and sitemap.xml include public discovery pages.
- [x] Add llms.txt and the requested llm.txt path.
- [x] Show a skills-first agent setup hub with supported client paths.
- [x] Preserve branded sign-in, safe return validation and invite boundaries.
- [x] Link agent setup and skills from the main website.

## First-run launchpad

- [x] Replace the empty customer Today view with three setup tiles.
- [x] Confirm a first recorded agent entry instead of pretending to start a worker.
- [x] Save an inline first task with existing permissions and retry behavior.
- [x] Use real membership evidence or an explicit scoped solo choice for collaboration.
- [x] Keep setup progress visible after the first task creates work.
- [x] Replace completed setup guidance with measured workspace state.

## Constraints and verification

Five minutes is a setup target. It is not a measured completion guarantee.
No existing backend can launch an arbitrary AI worker or prove a local tunnel heartbeat.
A registered key, roster name or copied prompt is not connection proof.
Do not add a fake GitHub integration or a successful invite without a real API result.
Public discovery content never grants permissions or exposes account data.
No production deployment follows from source implementation.
Health currently passes 18 desktop and phone checks and the focused model checks.
Run integrated tests after the discovery and launchpad components are ready.
