# LogMem plain-writing standard (logmem-plain-v1)

Status: Mikey adopted it for the whole fleet on 2026-10-14. It builds on ASD-STE100 Simplified Technical English.

People and other agents read LogMem entries, often days later. Clear entries make handoffs work. This
standard sets one way to write them.

## Rules for entry text

1. Put the result first. The first sentence says what happened or what the reader must do.
2. Write one idea per sentence. Keep sentences at 25 words or fewer, and 20 or fewer for instructions.
3. Use active voice. Name who did it: `atlas merged #32`, not `#32 was merged`.
4. State things directly. Do not use `should`, `would`, `may`, `might` or `could`. Give an instruction or a clear condition.
5. Cut filler. No openers (`Great question`), no closers (`Hope this helps`), no AI buzzwords (`delve`, `leverage`,
   `robust`, `seamless`, `tapestry`, `testament`).
6. Use periods and commas. No dashes and no semicolons.
7. Keep noun clusters to 3 words or fewer.
8. Copy ids, trails, numbers and commands exactly. Put them in `backticks`.

## How LogMem applies it

- **On connect:** the MCP server instructions tell every agent to write this way (`src/core/instructions.mjs`). Agents
  need no extra config.
- **On every write:** if an entry breaks a rule, the result carries `style: {standard: "logmem-plain-v1",
  warnings: [{rule, detail}]}` (`src/core/style.mjs`). The write still lands. LogMem never blocks on style. The
  agent fixes its next entry. LogMem does not check feed, recall, or any other read. Those results hold text
  from other agents.
- **The checks:** `long_sentence`, `passive_voice`, `weak_modal`, `filler`, `dash`, `semicolon`. The check skips
  text in backticks and lists, like the entry-kind list.

## The three levels (for agent and chat instructions)

Use the level that fits the surface.

1. **Strict, for LogMem entries, specs and runbooks:** all rules above. No contractions.
2. **Standard, for agent instruction files (AGENTS.md, CLAUDE.md, .cursorrules):**
   > Write in plain English in the spirit of ASD-STE100 Simplified Technical English. Keep sentences under 25 words.
   > Use active voice, simple tenses and concrete words. No filler openers or closers, em-dashes, semicolons or
   > corporate jargon. State the answer in the first sentence.
3. **Conversational, for chat with people:** the same, but contractions are fine:
   > Explain this in the spirit of ASD-STE100, but keep natural contractions. One idea per sentence, active voice,
   > no throat-clearing, no AI buzzwords and no summary wrap-up.

## Not in scope

LogMem does not enforce the full ASD-STE100 dictionary (~900 words). LogMem checks structure, not vocabulary.
