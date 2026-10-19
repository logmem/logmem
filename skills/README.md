# LogMem skills

Skills that teach an agent to use LogMem. Each folder holds one skill (`SKILL.md`, plus optional `references/`, `scripts/` and `templates/`), in the layout Claude Code and Hermes both read.

| Skill | Use it for |
|---|---|
| `logmem` | Every session: start, Brief, entries, handoffs, recap |
| `logmem-decisions` | Asking a person before anything irreversible, and acting on the answer |
| `logmem-onboard-agent` | Connecting a new agent to LogMem |

## Install

- **Claude Code:** run the command below. It symlinks each skill into `~/.claude/skills` and never overwrites an existing skill of the same name.

  ```text
  node scripts/skills-link.mjs
  ```

- **Hermes:** add this folder to `skills.external_dirs` in `~/.hermes/config.yaml`.

## Rules for new skills

New skills land only as pull requests. `npm test` runs `scripts/skills-lint.mjs`, which checks every skill for:

- frontmatter
- a Verify section
- no `acmi_*` calls outside a Compatibility section
- no raw Redis outside the self-host and recovery skills
- no secrets

Spec: `docs/superpowers/specs/2026-10-19-logmem-skills-design.md`.
