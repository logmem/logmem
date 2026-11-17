# Weekly npm release train

Status: workflow implementation draft. No npm publisher or GitHub environment settings have changed.

## Goal

Ship a tested npm release every week when package code changes. Skip the week when no package changed. Keep both install names clear:

- `logmem` remains the starter CLI and onboarding entry point.
- `@logmem/mcp` remains the MCP server package.

The current `logmem@0.1.0` tarball is a static help CLI. Weekly version bumps without code changes would add no user value. Keep its release tied to actual CLI or onboarding changes.

## Weekly flow

1. Run a scheduled release check on `main` each Tuesday at 16:00 UTC. Keep `workflow_dispatch` for a manual run.
2. Install from the committed lockfile, run repository CI, and check both package tarballs.
3. Compare each package's packed files with its latest npm release. Skip unchanged packages.
4. Open or update a release PR with independent SemVer patch bumps and changelog entries.
5. Dispatch `npm-ci.yml` against the release branch so its checks appear on the PR.
6. Publish only after the release PR merges and a reviewer approves the `npm-publish` environment.
7. Use npm Trusted Publishing with GitHub Actions OIDC. npm adds provenance for trusted publishes.

## Package rules

- Release `@logmem/mcp` from the root package only when server files changed.
- Keep the `logmem` CLI source and package manifest in `packages/logmem` before automating its release.
- Keep launch dates out of CLI help and package text unless they remain current.
- Keep the two packages' version bumps and changelogs independent.
- Do not publish empty weekly versions or move prerelease builds to `latest`.

## Authentication and release safety

- Use npm Trusted Publishing with GitHub Actions OIDC. Do not store a long-lived npm write token.
- Set up a trusted publisher for each package and the exact workflow filename.
- Use a GitHub-hosted runner, Node 22.14 or newer, npm 11.5.1 or newer, and `id-token: write`.
- Add a protected GitHub `npm-publish` environment with a human reviewer for each weekly release.
- The publish workflow checks that `npm-publish` has a required reviewer. It stops if the environment is missing or unprotected.
- Verify each package's `repository.url` matches `https://github.com/logmem/logmem` before enabling OIDC.
- Keep the existing Vercel production workflow separate from npm publishing.

## Current gaps

- The approved `logmem@0.1.0` package is a Drive tarball. The new `0.2.0` CLI draft now lives in `packages/logmem`.
- The root package metadata now points to the canonical `logmem/logmem` repository for npm provenance.
- Local npm publisher authentication returns `E401`.
- The one-time `logmem@0.1.0` publish job records approval. The Brief still projects it as pending.
- The weekly and publish workflows are local drafts. Do not publish until both npm trusted publishers and the protected environment are configured.
- GitHub Actions must be allowed to create pull requests. The workflow does not change repository settings.

## Acceptance

- A weekly run creates a release PR only when a package changed.
- A release PR shows the exact package contents, SemVer change, changelog, and green checks.
- A reviewer approves the publish through the protected GitHub environment.
- GitHub Actions publishes with OIDC and npm shows the expected version and provenance.
- `logmem` and `@logmem/mcp` retain their distinct purpose and install instructions.
