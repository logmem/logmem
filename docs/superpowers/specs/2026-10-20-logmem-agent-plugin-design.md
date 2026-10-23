# LogMem agent plugin: one package for ChatGPT, Codex and Claude

Status: DRAFT for Mikey's review, 2026-10-20. Owner: claude-code. Job: `chatgpt-logmem-plugin-plan` (plan `launch`).
Builds on: the ChatGPT MCP plan (Codex) and its review (claude-code), both 2026-10-20; `2026-10-19-logmem-one-click-connect-design.md`; `2026-10-19-logmem-skills-design.md`.
Scope: the package only. Server fixes are a separate PR (section 8). No merge, deploy, submission, npm publish or spend.

## 1. Goal

One plugin folder installs LogMem in ChatGPT, Codex and Claude Code. It connects the hosted MCP server with OAuth and ships the user-facing skills. claude.ai and Claude Desktop use the same server as a custom connector.

Done when the pilot users (Mikey and a couple of test users) can:

1. install the plugin in ChatGPT, Codex and Claude Code from the repo marketplaces
2. sign in and click one button
3. call `logmem_connection` and see their space and agent
4. read their Brief through `logmem_start`

## 2. Decisions (Mikey, 2026-10-20)

| Question | Decision |
|---|---|
| Pilot audience | Mikey plus a couple of test users |
| Clients | ChatGPT, Codex and Claude, built at the same time |
| Skills in v1 | Yes |
| Plugin name and place | `logmem`, in `plugins/logmem/` in this repo |
| Skills that ship | `logmem`, `logmem-decisions`, and a new `setup` onboarding skill. Fleet and self-host skills stay out |
| MCP URL | `https://logmem.si/mcp`. The server PR makes it the one canonical resource (section 8) |
| claude.ai and Claude Desktop | The same remote MCP server and OAuth, added as a custom connector |

## 3. Formats (checked live 2026-10-20)

**OpenAI Agent Plugins** (developers.openai.com/plugins/build/plugins):

- Root `plugin.json` with `$schema` `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`. Skills are found in `skills/<name>/SKILL.md`, with no `skills` field.
- Root `mcp.json` with `$schema` `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`. The server is `type: "streamable-http"` with OAuth `client.mode: "dcr"`. A DCR client carries no `clientId` and no secret.
- Presentation lives in `extensions.com.openai.interface`. `onboardingSkill` points at `./skills/setup/SKILL.md`. All paths start with `./`.
- Plugins with lifecycle hooks are not eligible for the public directory. This package ships none.
- Local testing reads `.agents/plugins/marketplace.json` at the repo root. The Codex desktop app also reads `.claude-plugin/marketplace.json`.
- The review found that a plugin carries one MCP server and that it must be in the first ZIP. Today's docs page does not state this limit. We ship one server either way.

**Claude Code plugins** (code.claude.com/docs/en/plugins-reference and marketplace-reference):

- Manifest at `.claude-plugin/plugin.json`. Every other file sits at the plugin root.
- MCP servers in a root `.mcp.json`. A remote server is `{ "type": "http", "url": "..." }`. Claude Code finds the OAuth server through the protected resource metadata and registers itself through DCR.
- Directory listing fields (`icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`) live only in `plugin.json`.
- A plugin with a top-level `bin/` folder does not install in claude.ai or Cowork. This package has none.
- `claude plugin validate --strict` passes on the plugin and on the repo marketplace (CLI 2.1.305).

**claude.ai and Claude Desktop:** a user adds `https://logmem.si/mcp` under Settings, Connectors, Add custom connector. The same OAuth and DCR flow runs. The plugin's skills reach these apps through the plugin, or as uploaded skills. A first-party directory listing for claude.ai is later work.

## 4. Package layout

```text
plugins/logmem/
  plugin.json                 portable manifest + extensions.com.openai
  mcp.json                    portable MCP config (streamable-http, OAuth DCR)
  .claude-plugin/plugin.json  Claude Code manifest
  .mcp.json                   Claude Code MCP config (type http)
  skills/
    logmem/                   copy of skills/logmem
    logmem-decisions/         copy of skills/logmem-decisions
    setup/                    plugin-only onboarding skill
  assets/                     LogMem logo and symbol copied from public/ds/logos (SVG)
  README.md                   install lines and links
.agents/plugins/marketplace.json   OpenAI repo marketplace
.claude-plugin/marketplace.json    Claude Code repo marketplace
```

Both manifests share the name, version, description, author, links and keywords. The test keeps them equal.

## 5. Skills: one source of truth

`skills/` at the repo root stays the source. A plugin ZIP cannot follow symlinks, so the plugin carries real copies.

- `scripts/plugin-sync.mjs` copies the shipped skills into the plugin.
- `node scripts/plugin-sync.mjs --check` fails on a missing, extra or changed file, and on an unlisted skill.
- `test/plugin.test.mjs` runs the same check in `npm test`, so drift fails CI.
- `setup` lives only in the plugin. The sync never touches it. The skills lint runs on all three plugin skills.

The `logmem` skill names `logmem-onboard-agent`, which does not ship. That pointer is harmless for pilot users. Trim it in `skills/logmem` later if it confuses them.

## 6. The setup skill

`setup` is the OpenAI onboarding skill and a normal skill in Claude. It walks the one-click connect for each app, then checks the result with `logmem_connection` and starts a shift. It never asks for a token, Redis URL or space. It tells an uninvited user to wait for the invite and stops.

## 7. Tests

`test/plugin.test.mjs` checks:

1. the portable manifest's required fields, and that skills need no field
2. the OpenAI interface fields, and that every asset and onboarding path exists inside the package
3. that the Claude manifest matches the portable one, including the listing links
4. exactly one MCP server, the same URL in `mcp.json` and `.mcp.json`, and OAuth DCR with no client id or secret
5. no hooks and no `bin/`
6. no secret-shaped strings, client credentials, headers, Redis URLs or agent keys in any package file
7. that the skill copies match `skills/` and pass the lint
8. that the sync check catches drift and the sync repairs it
9. that both repo marketplaces list the plugin by `./plugins/logmem`

`claude plugin validate --strict` is a manual step for now. The CLI is not a repo dependency.

## 8. Server gaps (separate PR, after Mikey approves the pilot scope)

The package is ready before the server is. These gaps block the pilot, not this PR:

1. Reads write: `shifts.touch` and `mirror.drain` run on read tools. A read-only connection must skip both.
2. HTTP `tools/call` skips the zod validation the stdio path runs.
3. The OAuth issuer comes from the `Host` header. Pin it from one env value.
4. Tokens carry no `resource` audience. Store and check it.
5. No RFC 9207 `iss` in authorization responses.
6. One `mcp` scope. Split into `logmem:read` and `logmem:write`.
7. `revocation_endpoint` is a placeholder. Build RFC 7009 or stop advertising it.
8. `/api/mcp` and `/mcp` are two resource ids. **The plugin uses `https://logmem.si/mcp`. The server PR must make that the one canonical resource** in the protected resource metadata, the token audience and the 401 challenge. If the server keeps `/api/mcp` instead, change `mcp.json`, `.mcp.json`, the setup skill and the README in the same PR. The test pins one URL across the package, so a half change fails.

## 9. Before public submission (not in this PR)

- Brand logo and symbol are now copied from `public/ds/logos`. Check target image formats and sizes before submission.
- Capture approved screenshots with provenance before adding directory screenshots.
- `https://logmem.si/privacy` and `/terms` must exist (sub-project 4).
- A verified OpenAI developer identity and domain verification for logmem.si.
- A ZIP build of `plugins/logmem/` that follows no symlinks.
- Run `claude plugin validate --strict` and the OpenAI plugin guidelines check.
- Both plugin manifests now declare the approved MIT license. The package includes `plugins/logmem/LICENSE`.

Package merge does not approve public submission. The package README keeps the current release checklist.
Repository catalogs do not establish a public directory listing.

## 10. Pilot test plan

| Client | Install | Check |
|---|---|---|
| Claude Code | `/plugin marketplace add` this repo, then install `logmem` | `/mcp` sign-in, `logmem_connection`, `logmem_start` |
| Codex desktop | Open this repo; the plugin shows from `.agents/plugins/marketplace.json` | sign-in on install, then the same two calls |
| ChatGPT | Public submission pending. Use a custom MCP pilot connection where supported | the same two calls |
| claude.ai | Custom connector with `https://logmem.si/mcp` | the same two calls |

Each pilot user runs the evaluation set from the review: a direct request, an indirect one, a follow-up, a write, and an unsupported request.
