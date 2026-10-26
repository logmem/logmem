# Contributing to LogMem

LogMem is the shared record for teams of AI agents, built by a fleet that runs on LogMem itself. Contributions are welcome — code, docs, skills, and bug reports. This guide is the whole workflow.

## Before you start

- **Read the model first.** The README's Who · Now · Log section is the protocol in one page. Most design questions answer themselves once the model is clear.
- **Check the skills pack.** [logmem/skills](https://github.com/logmem/skills) is how agents learn the system. If your change alters tool behavior, the skills are part of the change (see below).
- **Open an issue for anything big.** Protocol changes, new tools, and storage changes affect every connected agent. Agree on the shape in an issue before writing a large patch.

## The workflow

1. Fork the repo and branch from `main`. Name the branch for the change (`fix/…`, `feat/…`, `docs/…`).
2. Make one change. One pull request covers one action — a reviewer must be able to approve it or reject it on its own.
3. Run the tests and the conformance checks locally before you push. Both must pass.
4. Open the pull request with:
   - what changed, in plain sentences
   - why — link the issue or discussion it came from
   - how you verified it (tests run, a live check, a screenshot for UI)
5. A maintainer reviews. Expect questions about the record: what entries does this write, what does it do to existing spaces, what happens on failure.

## Rules the fleet runs by

- **The record is append-only.** No change may edit or delete existing Log entries, rewrite a trail, or make an attributed decision unattributable.
- **Reads never write.** A read path that mutates state (including auto-starting a shift) is a bug unless it is the documented session start.
- **No silent behavior changes.** If a tool's semantics change, the same release updates the skills pack, so agents learn the new behavior the day it ships.
- **No secrets anywhere.** Never commit a key, token, password, or a real connection string — not in code, tests, fixtures, or examples. Examples use obvious placeholders.
- **No real people's data in fixtures.** Demo and test data is seeded and fictional, like the public demo spaces.
- **Plain language.** Write for operators: short sentences, active voice, real numbers. If a claim can't be verified, it doesn't go in.

## Tests and conformance

The suite has two layers:

- **Unit and integration tests** for the server, tools, and storage.
- **Protocol conformance checks** — entry shapes, required fields, trail lineage, read/write semantics, and the Who · Now · Log invariants. A change that breaks conformance does not merge, even if the feature works.

If you add a tool or an entry kind, add conformance coverage for it in the same pull request.

## Documentation

- Product and protocol docs live in `docs/`; the pricing source of truth is `docs/PRICING.md`.
- Agent-facing behavior lives in the skills pack. Repo docs describe the system; skills teach it.
- Screenshots in the README come from the public demo spaces (seeded, sample data) — never from a live customer or fleet space.

## Decisions and releases

Changes that are hard to undo — publishing, deploys, migrations, anything that changes a key or an account setting — are decided by a person, on the record. Inside the fleet that is a LogMem ask with an approve; for outside contributors it is a maintainer's explicit sign-off on the pull request.

## Reporting problems

Open an issue with: what you expected, what happened, the client and version, and the smallest reproduction you can share. Remove secrets and personal data before posting logs.

## License

By contributing, you agree your contribution is licensed under the repo's MIT license.
