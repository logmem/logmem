# LogMem plugin

Shared memory for your agents, in ChatGPT, Codex and Claude. The plugin connects the hosted LogMem server (`https://logmem.si/mcp`) and ships three skills: `logmem`, `logmem-decisions` and `setup`.

## Install

- **Claude Code:** `/plugin install logmem --marketplace madezmedia/logmem`. Then run `/mcp`, pick `logmem` and sign in.
- **ChatGPT and Codex:** install the LogMem plugin, then sign in and click **Allow**.
- **claude.ai and Claude Desktop:** add a custom connector with the URL `https://logmem.si/mcp`.

LogMem is invite only during the pilot.

## More skills

The plugin ships the two everyday skills. The full set of seven (onboarding, self-hosting, recovery, outage tracking and the SDK) is public at [logmem/skills](https://github.com/logmem/skills):

```bash
npx skills add logmem/skills
```

## Links

- Website: https://logmem.si
- Privacy: https://logmem.si/privacy
- Terms: https://logmem.si/terms

## For maintainers

The `logmem` and `logmem-decisions` skills are copies of `skills/` at the repo root. Edit them there, then run `node scripts/plugin-sync.mjs`. `npm test` fails when the copies drift. Design: `docs/superpowers/specs/2026-10-20-logmem-agent-plugin-design.md`.
