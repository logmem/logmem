# LogMem distribution and the standard start

Status: approved by Mikey on 2026-10-21 ("approved for Go all hands").
Plan: `launch` (P0). Track: `distribution`. Driver: claude-code. Reviewer: codex.

## Goal

Every supported agent connects to LogMem and starts the same way, and LogMem is
installable from npm, the MCP Registry and Smithery by Show HN (Nov 10).

Supported at Show HN: Claude Code, Codex, Claude web and desktop, ChatGPT,
the Gemini app and the Gemini CLI.

## Decisions

1. **The agent name is set once, at connect.** It comes from `LOGMEM_AGENT`
   (stdio), the agent key, or the name picked on the OAuth sign-in page.
   After that, a bare `logmem start` starts that agent. A typed name still
   overrides it, unless the connection is locked to one agent.
2. **The server enforces the start.** The rules live in the server, so a
   client with no skills (Gemini web) behaves the same as one with skills.
3. **Skills come in two layers.** The server instructions carry the core
   rules (start, Brief, write, ask, recap). A public `logmem/skills` repo and
   plugin #90 add depth. `npx skills add logmem/skills` installs them.
4. **The repo moves this week.** `madezmedia/logmem` moves to
   `logmem/logmem`. GitHub redirects the old URLs. Mikey clicks the transfer.
5. **Listings at Show HN:** npm `@logmem/mcp`, the MCP Registry
   (`io.github.logmem/logmem`, remote `https://logmem.si/mcp`) and Smithery.
   Directories (Glama, mcp.so, PulseMCP) and the ChatGPT and Anthropic app
   stores are parked until after Show HN.

## The standard start

1. **Connect.** The person adds LogMem with the client's own method: config
   for stdio, or the URL `https://logmem.si/mcp` with browser sign-in.
   logmem.si/connect shows one tab per client.
2. **Start.** The person says `logmem start`. With no name, LogMem uses the
   bound agent. If nothing is bound, the tool answers with a clear error that
   names the fix ("say logmem start <name>, or set LOGMEM_AGENT").
3. **Brief.** The start returns the Brief. On the agent's first start ever,
   the Brief also carries `welcome`: the three habits (read the Brief, write
   as you go, recap before you stop) and one example call for each.

## Milestones and jobs

| Milestone | Date | Done when |
|---|---|---|
| `dist-m1-one-start` | Oct 24 | A bare `logmem start` works over stdio, an agent key and OAuth. The first start returns `welcome`. The sign-in page sets the agent name. #96 and #91 are merged. |
| `dist-m2-org-skills` | Oct 28 | The repo is at `logmem/logmem`. `logmem/skills` is public with the product skills and bentley's review fixes. `npx skills add logmem/skills` installs them. Plugin #90 points at the new repo. |
| `dist-m3-verified` | Nov 3 | A clean-room run on each of the six clients reaches the Brief and writes one note, with the evidence on the job. logmem.si/connect is live. |
| `dist-m4-listed` | Nov 6 | `@logmem/mcp` is on npm. The MCP Registry and Smithery entries point at `logmem.si/mcp`. |

Jobs:

- `dist-bare-start` (claude-code, M1): `logmem_start` with an optional agent, the welcome Brief, tests.
- `dist-consent-agent-space` (claude-code, M1): the sign-in page names the agent and, for admins, picks the space.
- `launch-move-madezmedia-logmem-logmem-logmem` (Mikey, M2): the transfer click, with a walkthrough.
- `dist-public-skills-repo` (claude-code, M2): `logmem/skills`, with bentley's fixes from madezmedia/fleet#1.
- `dist-clean-room-runs` (claude-code with a second agent, M3): one run per client.
- `dist-connect-page` (claude-code, M3): logmem.si/connect.
- `launch-npm-publish-logmem-mcp-logmem-sdk` (grok-local, M4): publish after Mikey's GO.
- `launch-mcp-registry-smithery-entries` (claude-code, M4): the registry and Smithery entries.

## Risks

- **GitHub Actions billing lock.** CI does not run on GitHub until Mikey
  clears it. That includes the new org.
- **npm was marked trademark-gated.** Mikey confirms before publishing.
- **Which space a web sign-in grants.** Today a managed sign-in gets a new
  space, not madez. `dist-consent-agent-space` settles it for admins.

## Out of scope

Directories and app stores (after Show HN), the landing page and redesign
(track C), and the time and schedule views (track B).
