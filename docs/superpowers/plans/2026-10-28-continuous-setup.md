# Continuous Setup Implementation Plan

**Goal:** Keep onboarding in one themed, resumable flow.
**Architecture:** Shared theme tokens and guided client component. Public entry and customer launchpad share step rendering.
**Tech Stack:** Vanilla JavaScript, lit-html, existing HTML and CSS.
**Spec:** docs/superpowers/specs/2026-10-28-continuous-setup-design.md

- [x] Extract shared palette CSS. Apply theme before paint on public entry and login.
- [x] Add safe guide preferences and client return links. Test allowlists and scoped state.
- [x] Add inline skill reader, connection instructions and verification step.
- [x] Integrate public entry and launchpad. Keep task drafts and retry IDs within the customer scope.
- [x] Verify reload, Previous, Save and exit, auth return, permissions, themes and narrow layouts.
- [x] Publish a draft PR and record remaining provider acceptance checks.

No worker launch, provider changes, deployment or live repairs.

Validation: 1017 repository tests, 32 desktop and phone cases, and six final return/theme cases pass.
Provider authorization uses fixtures. Real provider acceptance still needs a live check.
