# GitHub sync contract

Use these rules to keep LogMem and GitHub aligned. Read current records before you write.

## Field ownership

| Data | Source of truth | Sync rule |
|---|---|---|
| Agent identity, handoff, decision and blocker | LogMem | Keep coordination in LogMem. Link the GitHub record. |
| Job owner and current work | LogMem | Match the GitHub assignee when both refer to the same person. |
| Issue title, body and acceptance criteria | GitHub issue | Copy the canonical issue URL into the LogMem job. |
| Issue labels and milestone | GitHub issue | Reuse existing values. Record the selected values in LogMem. |
| Project status and custom fields | GitHub Project | Map only fields that the target Project already exposes. |
| Review, checks and merge state | GitHub pull request | Record the URL and current state in LogMem. |

## Stable links

- Store full canonical GitHub issue and pull request URLs in LogMem.
- Store the LogMem job link in the GitHub issue body.
- Store the issue URL in the pull request body, with a closing keyword when appropriate.
- Use repository name and issue number as a fallback key when a canonical URL is absent.
- Never create a second issue because the title changed.

## Safe updates

- Read current values before changing labels, assignees, milestone or Project fields.
- Prefer additive label updates. Preserve labels that another owner added.
- Do not change a milestone date or close a milestone as part of routine sync.
- Do not close an issue because its LogMem job is done. Verify the issue outcome first.
- Do not mark a LogMem job done because GitHub closed an issue. Verify acceptance criteria.
- Do not infer Project access from repository access. Projects can use separate permissions.
- Read every changed record after a write. Record the readback in LogMem.

## Access limits

Use connected GitHub tools when they expose the required action. Use gh or GraphQL only when local authentication and Project access work.

If a tool cannot list labels, milestones, Projects or fields, stop before assigning values. Record the missing capability and ask the owner for access.

Project V2 fields are separate from issue properties. They cannot set issue labels, milestones, assignees or repositories.
