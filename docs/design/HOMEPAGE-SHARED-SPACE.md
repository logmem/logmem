# Business homepage with shared LogMem spaces

Mikey approved the OpenPod layout and conversion direction, then requested LogMem's own design system and business examples.
The homepage replaces the fictional newsletter and agent personas with familiar AI tools and practical work.

## Experience

The centered hero introduces one shared space for the tools a business already uses.
A copyable prompt appears before technical setup instructions. Human and agent tabs provide separate guidance.
Real agent marks identify Claude, ChatGPT, Codex, Cursor, Gemini, and Hermes. Codex uses OpenAI's provider mark.
Animated timelines show customer follow-ups, restaurant readiness, and a customer signup fix.
Eight business tabs cover solo operators, developers, small businesses, trades, restaurants, salespeople, managers, and small teams.
Each shows a conversation, a next step, and an actual dashboard capture from the relevant synthetic sample space.

## Design system

Load the existing token and component CSS bundles.
Use Schibsted Grotesk, IBM Plex Sans, IBM Plex Mono, the existing LogMem lockup, and semantic colors.
Use the shared panels, timeline rows, agent identities, badges, buttons, and demo label.
All fonts, logos, and screenshots load locally. Logo provenance lives beside the files.
Motion respects reduced-motion settings. Timed examples pause when the document is hidden.
Native scrolling and keyboard tabs remain available.

## Conversion and truth

The setup dialog changes guidance for the selected client and ends at the existing `/onboarding` route.
It does not authenticate, save credentials, or claim an agent connected.
Preserve attribution scripts, sign-in, hosted waitlist wording, and the existing approval caveat.
The access switch demonstrates interface states only. It changes no live agent.
Conversations and dashboard screenshots carry clear synthetic-data labels.

## Sample data

Five spaces use real LogMem tool calls over isolated in-memory Redis.
See `docs/demo/BUSINESS-SPACES.md` for audiences, contents, commands, and isolation boundaries.
Screenshots show the existing application over those spaces. They are not dashboard mockups.

## Verification

Check all audience tabs, screenshot selection, prompt branches, client choices, copy feedback, setup handoff, modal dismissal, and phone layout.
Check that fixtures contain real jobs, stages, decisions, and handoff trails without cross-space data leakage.
Retain site security, attribution, and social metadata tests.
Backend connections, cross-person sharing, unattended replies, and enforced pause remain outside this change.
