# Release Source Preflight Implementation Plan

**Goal:** Reject stale and dirty release sources before staging a production build.
**Architecture:** A standalone Node command checks Git and the existing Vercel link. It emits a source receipt without deploying.
**Tech Stack:** Node 22, Git, node:test.
**Spec:** docs/superpowers/specs/2026-10-27-release-source-preflight-design.md.

## Global constraints

Use no new dependencies. Keep credentials out of receipts.
Preserve the existing production project and team.
OpenCode owns access restrictions and CI release integration.

## Review focus

Reject missing source and project evidence.
Fetch main before comparing revisions.
Inspect staged, tracked and untracked changes.
Do not confuse an approval reference with verified approval.
Document direct CLI bypass and later source mutation.

## Task 1: Source gate and real Git regression tests

Files: scripts/release-preflight.mjs, test/release-preflight.test.mjs.
Interface: checkReleaseSource({cwd, approvedSha, approvalRef}) returns a receipt or throws.

- [x] Write temporary Git fixture tests for accepted and rejected release sources.
- [x] Run tests and confirm missing implementation fails.
- [x] Implement source, remote, project, fetch and cleanliness checks.
- [x] Run focused tests and required repository checks.
- [x] Commit the gate, tests and operator documentation.

## Task 2: Integration handoff

- [x] Document the command in docs/ops/release-source-preflight.md.
- [x] Pass the incident revision as the approved revision and verify rejection against the current source.
- [ ] Post exact revision and test evidence on job release-source-preflight.
- [ ] Hand the receipt contract to OpenCode for CI enforcement.

This session uses native execution. The user requested continuation of the agreed plan.

## Verification checkpoint

Nine source tests and one managed shared-record test pass.
All 910 repository tests, schema checks and 30 conformance cases pass.
The managed test proves both write directions and denies a second customer.
This uses isolated memory storage. Production customer acceptance remains open.
The source command rejects the incident revision as mismatched approval input.
Restricted CI and direct CLI bypass remain outside this slice.
