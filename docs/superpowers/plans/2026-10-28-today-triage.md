# Today command and triage layout

Implement Michael's three-tier layout in the existing HTML app.
This branch builds on PR 172 for the shared dispatch controls.
Merge PR 172 before this branch.

## Components

- BentoTaskCard keeps request type, literal summary, metadata and a fixed action baseline.
- PlanProgressTile shows progress, completion counts and the next recorded milestone.
- TerminalActionBanner offers Copy dispatch and Review decision for the first pending decision.
- Operations combines current plans, a team summary and collapsed workspace guidance.

## Behavior

One full-width status strip filters Decisions, Tasks, Waiting and Done without navigation.
Clicking an active status restores All. Preferences stay within the active space.
Waiting shows loaded blocked records. Done shows completion by loaded plan.
Operations collapses by keyboard and gives the reading canvas more width on desktop.
Phone layouts stack the reading canvas and operations panel.
The assistant no longer creates a third Today column.

Approval remains in the existing review drawer.
The app has no verified agent runner, so the banner does not promise Approve and Dispatch.
Copying a prompt performs no mutation and retains the existing clipboard fallback.
Plan expansion shows only the next milestone returned by the API.
A link opens the full plan instead of fabricating a checklist.

## Verification

All 987 repository tests pass.
Thirty focused model and client checks pass after final changes.
Four final desktop and phone tests verify filtering, equal tile heights, sidebar collapse and all four themes.
Existing Home, live draft, personal task, approval and completion browser checks pass.
Three existing phone tests skip by design because those shared-seed writes run on desktop.
The old task-summary test now follows status filtering and then Review task.
No server authorization or deployment changed.
