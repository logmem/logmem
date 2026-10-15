# Homepage v3: design brief (2026-10-14)

Inputs: two external design reviews (UX/conversion, and motion/WebGL), both shared by Mikey on 2026-10-14; Cursor's
PR #37 (homepage claim fixes); the LogMem design system (`public/ds/`); and the design canvas (artifact
`TrG6Y3v3QNt9gr1xF2QWNe`, Main + Onboarding artboards).

**Goal for this release: waitlist sign-ups.** This also answers the reviewer's question. Today the page sells the
hosted waitlist. Self-hosting opens when `@logmem/mcp` is published (after the Oct 15 trademark check) or the repo goes
public. Until then the page must not offer a working install.

## What the reviews got right (keep)
- The copy is the asset: plain words (Start, Brief, Note, Handoff, Ask, Recap) for protocol ideas, and an honest tone.
- The visual identity: warm paper, forest green, an editorial grid, a field-notebook feel. It stands out next to
  dark/neon AI pages. **Motion must feel tactile (ink, paper, relays), never sci-fi.**

## Phase 0: truth and conversion (copy only). Owner: Cursor PR #37. Retarget it to `feat/site-pass-a`.
Already in #37:
- Remove "Run it today / Self-host on your own Redis", plus both self-host buttons.
- One waitlist CTA in the hero and in the close.
- Make Ask-first consistent everywhere.

Add to #37 from the review:
1. **Reframe the ask-first caveat**, once, around the roadmap, not as an apology repeated twice. Proposed wording:
   "Today, agents that follow LogMem pause and ask. Server-side locks ship in v1." The wording has to stay true:
   approvals are off in production until `LOGMEM_DECIDE_SECRET` is set.
2. **Footer:** remove every `SOON` item. Keep only the live links (Demo, Onboarding/waitlist, ACMI spec) and the
   company credit.
3. **Code snippet:** label it "Preview of the install. Join the waitlist to get access." Never present it as a command
   people can run today.

## Phase 1: layout (static HTML/CSS/JS). Owner: claude-code, after #37 merges, since both touch the same files.
1. **Two-column hero.**
   - Left: headline and the one waitlist CTA.
   - Right: a compact live log card that ticks through one handoff, `quill (via claude-code)` → handoff →
     `atlas (via cursor)` → accepted. Use the real `lm-event` components.
   - Below the card: a mini **approval card** (Pending, then Approve/Reject) so the human-yes idea is visible
     without reading.
2. **Habits ergonomics line** under "How it works": "The habits arrive with the connection. LogMem's MCP server sends
   them to the agent on connect, so there's no CLAUDE.md or .cursorrules to edit." This is true:
   `src/core/instructions.mjs` is served as MCP `instructions` on initialize.
3. **Host-first demo.** In the Field Notes demo, the host badge (`via claude-code`, `via cursor`, `via claude-web`)
   becomes the main visual element and the persona name the secondary one. The story becomes "planned in Claude Web,
   coded in Cursor, debugged in Claude Code".
4. **Show the entry** toggle on each demo step: a human view and the raw entry JSON (`{ts, kind, by, via, trail,
   origin, summary}`, real field names, ms timestamps).

## Phase 2: motion. Owner: open-design (concepts) → claude-code (build).
A direction, not a spec. A concept review comes first, as stills plus one short motion study, before any build.

| Idea from the review | Decision | Why |
|---|---|---|
| WebGL "memory spine" hero (R3F, dithering) | **Concept only.** Build as SVG/Canvas 2D first; WebGL only if the concept wins | The site is static with no build step; R3F needs React and a bundler; LCP and mobile cost |
| Scroll-driven demo timeline (pinned, playhead, approval "barrier" at 70%) | **Yes, as a sticky section, no scroll hijack.** Native scroll with `position: sticky` and an IntersectionObserver; no Lenis/GSAP | Accessibility and trackpad feel; zero dependencies |
| Grain/noise background shader | **Yes, as a static or CSS grain texture.** No full-page live shader | Battery and GPU cost for little gain |
| Split-flap text scramble on Connect tabs | Yes, small | Cheap, on-brand |
| Use-case micro-simulations (Rive/Matter.js) | Later, if at all | Dependency weight |
| X-ray lens over "Built on ACMI" (cursor `mask-image`) | Yes, CSS only | Cheap, explains the ACMI ↔ LogMem mapping |
| Millisecond ticker in the header | Yes, small, pauses off-screen | Reinforces the trust pillar |
| Mechanical easing (springs, `cubic-bezier(0.22, 1, 0.36, 1)`) | Yes, as a design-system token | Consistency |

**Hard constraints for every motion idea:**
- CSP is `script-src 'self'`. No CDNs, so any library is vendored and served from `/vendor`.
- `prefers-reduced-motion`: every animation has a static equivalent.
- Budget: ≤ 60 KB of JS added for Phase 2 (gzipped). LCP ≤ 1.8 s and CLS ≤ 0.05 on mobile.
- Nothing blocks the waitlist CTA, and no scroll hijacking.
- WCAG: text contrast ≥ 4.5:1 in both themes, and keyboard access to every interactive demo step.

## Acceptance (per phase)
- **P0:**
  - no claim on the page is untrue today, checked against production;
  - no SOON items;
  - `test/site.test.mjs` locks the claims.
- **P1:**
  - two-column hero on desktop, stacked at 375 px;
  - the live log and approval card use DS components;
  - JSON toggle;
  - host badges lead;
  - Lighthouse a11y ≥ 95, and no new external requests.
- **P2:**
  - Mikey approves the concept;
  - the budgets above pass;
  - the reduced-motion static fallback works.
