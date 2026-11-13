---
name: logmem-github-dev-team
description: Coordinate software work between LogMem and GitHub Projects, milestones, labels, issues and pull requests. Use when a team needs one traceable plan across both systems.
---

# LogMem GitHub dev team

Use LogMem for team coordination and GitHub for repository work. Keep links between each job, issue and pull request. Read both systems before you change either one.

## When to use this skill

Use this skill when you plan software work in LogMem and track delivery in GitHub. Use it when you create or update GitHub issues, milestones, labels, Project items or pull requests.

## Ownership rules

- LogMem owns agent identity, current work, decisions, handoffs, blockers and coordination notes.
- GitHub owns issue and pull request text, assignees, labels, milestones, review state and merge state.
- A GitHub Project owns board views and project fields. Project fields do not replace issue labels or milestones.
- A LogMem plan groups work. A GitHub Project groups repository items. Link them by recording canonical URLs in both systems.
- A LogMem job tracks one owned unit of work. A GitHub issue describes that same unit of work.
- A pull request delivers code for one or more issues. Link it to each issue with `Closes #<number>` when merge should close the issue.

Read [the sync contract](references/sync-contract.md) before a multi-item sync or any conflict repair.

## Start a sync

1. Read the LogMem Brief, job, plan and recent entries. Keep the active owner and trail.
2. Read the GitHub repository, issue, labels, milestone and project item that match the LogMem job.
3. Match records by canonical URL first. Match by repository and issue number next. Do not match by title alone.
4. Find the repository's existing labels and milestones before you assign them. Reuse current names and dates.
5. Confirm that the GitHub Project belongs to the intended owner or repository. Confirm its fields and status options before mapping values.
6. Write a short sync plan in the LogMem job. Include the repository, issue URL, milestone, labels, project URL and next action.

## Map work to GitHub

1. Keep one GitHub issue for each LogMem job that needs repository delivery.
2. Put the LogMem job link and plan name in the issue body. Put the GitHub issue URL in the LogMem job details.
3. Set the issue milestone to the release or checkpoint that owns the work. Do not create a milestone without its owner and due date.
4. Apply existing labels that describe type, area, priority or state. Do not use labels to copy Project fields.
5. Add the issue to the correct GitHub Project. Set only fields that exist in that Project.
6. Assign the GitHub issue to the person who owns the code work. Keep the LogMem job owner aligned when the same person owns both.
7. Put acceptance criteria and scope in the issue. Put live coordination and handoff notes in LogMem.

## Open and sync a pull request

1. Put the issue number in the branch name or pull request title when repository rules allow it.
2. Link the pull request to its issue with `Closes #<number>` when merge should close the issue.
3. Add the pull request to the same Project as the issue when the team tracks pull requests there.
4. Record the pull request URL and current review state in the LogMem job.
5. Update the LogMem job when review, CI, merge or release state changes. Keep the GitHub pull request as the source for those GitHub states.
6. After merge, read the pull request and issue again. Record the merge commit or release evidence in LogMem.
7. Mark the LogMem job done only when its acceptance criteria pass. A merged pull request alone does not prove delivery.

## Resolve drift

1. Read both records again before editing either one.
2. Preserve each system's owned fields from the ownership rules.
3. If a title, scope or owner conflicts, ask the LogMem job owner to choose. Record the answer before changing GitHub.
4. If GitHub access, permissions or an API is missing, record the exact blocker in LogMem. Do not claim the sync completed.
5. Make the smallest safe update. Read both records again and record the result.

## Verify

1. Read the LogMem job and confirm its GitHub issue and pull request links.
2. Read the GitHub issue and confirm its LogMem link, milestone and labels.
3. Read the Project item and confirm its status and fields when Project access exists.
4. Read the pull request and confirm its issue link and current review or merge state.
5. Record any missing access, unresolved conflict or failed readback in LogMem.
