# LogMem plugin

This repository contains the LogMem plugin package for supported hosts.
It connects to `https://logmem.si/mcp` and ships eight skills: `setup`, `logmem`, `logmem-decisions`, `logmem-onboard-agent`, `logmem-seed-space`, `logmem-read-path-recovery`, `logmem-sdk-primitives` and `logmem-track-outage`.
Public directory submission remains pending. This package does not establish a public ChatGPT, Codex, or Claude directory listing.

## Install from this repository

- **Claude Code:** run `/plugin marketplace add madezmedia/logmem`. Use the `/plugin` menu to install `logmem` from the `logmem` marketplace.
  Then run `/mcp`, select `logmem`, and sign in. Repository access is required.
- **Codex:** this repository supplies `.agents/plugins/marketplace.json`, which references `./plugins/logmem`.
  Use a Codex host that supports repository plugin catalogs. Repository metadata does not prove installation in every host.
- **ChatGPT:** this package includes a portable manifest, but public directory installation is not available through this PR.
  A pilot can use a custom MCP connection where its account supports that feature.
- **claude.ai and Claude Desktop:** use a custom connector with `https://logmem.si/mcp` where custom connectors are available.

After OAuth sign-in, click **Allow**. Check `logmem_connection`, then start a shift with the returned agent.
Claude's repository marketplace instructions are documented in [Claude Code plugins](https://claude.com/blog/claude-code-plugins).

LogMem is invite only during the pilot.

## More skills

Seven skills ship in the plugin besides `setup`. Only `logmem-self-host` stays out, because it shows a Redis connection string and the plugin carries no backend strings. It is public at [logmem/skills](https://github.com/logmem/skills):

```bash
npx skills add logmem/skills
```

## Links

- Website: https://logmem.si
- Privacy: https://logmem.si/privacy
- Terms: https://logmem.si/terms

## For maintainers

Every skill except `setup` is a copy of `skills/` at the repo root. Edit them there, then run `node scripts/plugin-sync.mjs`. `npm test` fails when the copies drift. Design: `docs/superpowers/specs/2026-10-20-logmem-agent-plugin-design.md`.

Both plugin manifests declare MIT. The package license is in `LICENSE`.
The logo copies come from `public/ds/logos/logmem-lockup.svg` and `public/ds/logos/logmem-symbol.svg`.

## Public release checklist

Package merge and public submission have separate acceptance gates.
The following checks must pass before public submission:

- [ ] Serve approved privacy and terms pages at the manifest URLs. Prior review found both URLs returned 404.
- [ ] Verify the actual HTTP responses and approved policy text. This package does not supply legal policy.
- [ ] Verify the developer identity and domain required by the target directory.
- [ ] Confirm accepted image formats and sizes. The package now uses actual LogMem SVG brand assets.
- [ ] Capture approved screenshots and verify their provenance before adding directory screenshots.
- [ ] Build a plugin ZIP without symlinks and validate the target host manifest.
- [ ] Run the target platform's submission checks and complete OAuth installation tests on supported pilot clients.
- [ ] Record the approved submission target and human authorization. This PR performs no submission.

Repository catalogs and manifests are package artifacts. They are not proof of directory approval or public listing.
