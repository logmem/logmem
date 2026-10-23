# Shared-space homepage replacement

Mikey approved the OpenPod UI direction on October 23, 2026.
He requested its smooth motion, prompt-first conversion, and familiar agent interactions.
He rejected the Fieldnotes and Quill newsletter example.

## Experience

A centered hero leads with familiar AI tools and one shared LogMem space.
The hero offers human and agent prompts before the visitor needs technical setup details.
An animated conversation shows a website launch, a trip plan, and an idea review.
Each example shows agents exchanging context and returning a concrete next step.
Use-case tabs explain continuity, teamwork, and shared context through short conversations.
Agent choices update the prompt, preview, and platform guidance together.
A three-step dialog ends at the existing /onboarding route.
The homepage does not authenticate, store credentials, or claim a connection succeeded.

## Implementation

Replace public/index.html, home.css and home.js.
Use original SVG illustrations and existing LogMem fonts. No runtime dependencies or third-party artwork ship.
Keep attribution scripts, sign-in, hosted waitlist truth, and the existing approval caveat.
Do not change backend access, onboarding APIs, or application fixtures.
A visible switch demonstrates connection states only. It changes no real agent.

## Verification

Check keyboard tabs, prompt updates, clipboard behavior, scenario changes, setup handoff, modal dismissal, and phone layout.
Honor reduced motion and pause the timed example while the document is hidden.
Retain site security checks and update the old homepage layout assertions for the new experience.

## Feature boundary

Cross-person sharing, unattended replies, universal wake support, enforced pause, and provider integrations require separate backend verification.
The homepage must not describe those capabilities as universally available.
