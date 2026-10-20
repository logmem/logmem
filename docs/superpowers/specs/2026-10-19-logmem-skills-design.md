# LogMem skills: owned, canonical and LogMem-native — design

Status: APPROVED by Mikey, 2026-10-19. Owner: claude-code. Reviewer: codex.
Appendix: `2026-10-19-logmem-skills-triage.md` (all 169 ACMI skill files, one row each).

## 1. Problem

The fleet's skills grew without an owner:

- 169 skill files mention ACMI. Hermes has 94 of its own, and the ACMI protocol repo's skill pack (`~/clawd/skills/acmi`, linked into Hermes as `acmi`) has 75.
- 74 of them are near-duplicate "bridge outage", "fallback" and "track" variants. Hermes's skill curator (on, `guard_agent_created: false`) most likely made them during past outages.
- The deep ones call Redis directly through the bridge. That skips LogMem, so the dogfood check never sees that work, and the skills break on bridge quirks (WRONGTYPE, 403s).

LogMem is now the fleet's canonical record (Mikey, Oct 19), so the skills must be LogMem-native and have one owner.

## 2. Decisions (Mikey, 2026-10-19)

| Question | Decision |
|---|---|
| Where skills live | Split. Product skills in the logmem repo (`skills/`), fleet skills in the private fleet repo (`skills/`) |
| How deep | Rewrite to `logmem_*` tools. Raw Redis only in the self-host and recovery skills |
| Old ACMI copies | Keep both side by side. The old skills stay live and untouched |
| Who creates skills | Hermes's curator proposes, and a PR decides (`guard_agent_created: true`). New skills land only through PRs |

## 3. The skills

**Product skills, `madezmedia/logmem` `skills/` (7).** These ship with LogMem.

| Skill | Built from |
|---|---|
| `logmem` | The ACMI core skill. Covers start, brief, notes, jobs, handoffs and recap |
| `logmem-decisions` | fleet `docs/LOGMEM-DECISIONS.md`. Ask, wait, act on approve, confirm a chat decision |
| `logmem-onboard-agent` | fleet `docs/LOGMEM-ROLLOUT.md` 4b. The three connect paths and the start prompt |
| `logmem-read-path-recovery` | 58 recovery and outage variants merged |
| `logmem-track-outage` | 22 track and cron variants merged |
| `logmem-self-host` | `acmi-self-hosted-redis` and `devops/acmi-self-hosting` |
| `logmem-sdk-primitives` | `acmi-typescript-primitives` |

**Fleet skills, `madezmedia/fleet` `skills/` (11):**

- `logmem-fleet-roundtable`
- `logmem-fleet-orchestration`
- `logmem-fleet-audit`
- `logmem-fleet-sync`
- `logmem-fleet-ops-center`
- `logmem-fleet-rollup`
- `logmem-fleet-monitoring`
- `logmem-fleet-kanban`
- `logmem-fleet-hermes-deploy`
- `logmem-fleet-voice-agents`
- `logmem-fleet-duane-queue`

The appendix maps each old skill to its new one.

**Everything else (see the appendix):**

| Group | Count | Action |
|---|---|---|
| Archived | 19 | Leave as they are |
| Junk (test and probe writes) | 8 | Listed for Mikey to delete. Nothing is deleted in this project |
| Light (ACMI in passing) | 38 | Edit in place: swap the logging calls for `logmem_note` or `logmem_update` |
| ACMI console | 1 | Retire. `logmem.si/app` replaces it |

## 4. Format and rules

- **Folder layout:** one folder per skill, holding `SKILL.md` plus optional `references/`, `scripts/` and `templates/`. This is the layout Hermes and Claude Code both read.
- **Frontmatter:** `name` and `description`. A rewritten skill's description starts with "Use this instead of `<old skill>` (ACMI)." so agents pick the LogMem version.
- **Tools:**
  - Only `logmem_*` tools.
  - `acmi_*` calls appear only in a short "Compatibility" note.
  - Raw Redis (`redis-cli`, `ZADD`, `HSET`, `/bridge/exec`) only in `logmem-self-host`, `logmem-read-path-recovery` and `logmem-track-outage`.
- **Writing:** plain English, the fleet writing standard (`docs/spec/WRITING.md`).
- **Secrets:** none, in any skill or example. Use placeholders such as `<vault: custom.logmem>`.
- **Verify:** every skill ends with a "Verify" step: what to read back to prove it worked.

## 5. Install, with both versions live

- **Hermes:** add the two repo folders to `skills.external_dirs` in `~/.hermes/config.yaml`, next to the existing open-design folder. Back up the file first. No copies, so nothing drifts.
- **Claude Code:** `scripts/skills-link.mjs` (in each repo) symlinks every skill folder into `~/.claude/skills`. It skips any name that already exists and is not its own link.
- **The VM:** the same folders through a checkout, later, with the host owner.
- **The checkout Hermes reads** is a main worktree that pulls on a schedule (`~/clawd/projects/logmem-main`, `~/clawd/fleet`). Hermes never reads a feature branch.

## 6. Owning creation

- New skills, and changes to these 18, land only as PRs to the two repos. codex reviews them.
- Hermes's curator stays on, with `guard_agent_created: true`, so its drafts wait for approval. Once a week, claude-code reads the drafts, turns the good ones into PRs, and lists the rest.
- The lint (section 7) runs on every PR.

## 7. Test: the skills lint (`scripts/skills-lint.mjs`, part of `npm test`)

For every `skills/*/SKILL.md`, the lint checks that:

1. the frontmatter has `name` (equal to the folder name) and `description`
2. there are no `acmi_` calls outside a "Compatibility" section
3. there is no raw Redis outside the three allowed skills
4. there are no secret-shaped strings, using the patterns of `src/core/secrets-guard.mjs`
5. there is a "Verify" heading
6. there is no em dash, and no sentence longer than 25 words (warn only)

## 8. Waves (one PR each)

1. **Product core:** `logmem`, `logmem-decisions`, `logmem-onboard-agent`, the lint and the link script.
2. **Product recovery:** `logmem-read-path-recovery`, `logmem-track-outage`, `logmem-self-host`, `logmem-sdk-primitives`.
3. **Fleet:** the 11 fleet skills.
4. **Light edits:** the 38 edits in place (in Hermes's folder and the ACMI pack). Each gets a backup first.
5. **Wiring:** Hermes `external_dirs` and the curator guard (needs Mikey's OK, backup first), plus the Claude Code links and the junk list for Mikey.

## 9. Done when

- The 18 LogMem skills are merged and pass the lint.
- Hermes and Claude Code load them, and an agent using them writes through LogMem: entries appear in `lm:madez:*`.
- The curator guard is on.
- Every old skill has a row in the appendix, and its LogMem replacement or edit exists.

## 10. Not in this spec

- Deleting old skills (Mikey decides from the junk list later).
- Publishing the product skills publicly (that waits for the trademark filing and the logmem org move).
- The VM install.
