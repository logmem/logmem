---
version: alpha
name: LogMem
description: Shared memory and agent coordination workspace for solo operators and engineering teams.
colors:
  bg: "#F4F6F5"
  surface: "#FFFFFF"
  surface-raised: "#FFFFFF"
  surface-sunken: "#EAEEEC"
  border: "#D3DAD8"
  border-strong: "#7A8784"
  text: "#121A19"
  text-muted: "#46534F"
  text-subtle: "#5C6966"
  text-inverse: "#F4F6F5"
  brand: "#0E6863"
  brand-hover: "#0A524E"
  brand-subtle: "#DDF1EE"
  on-brand: "#FFFFFF"
  focus: "#2453D6"
  link: "#0B5E59"
  success: "#1E6B35"
  success-subtle: "#E2F1E5"
  warning: "#875100"
  warning-subtle: "#FBEED6"
  danger: "#B42318"
  danger-subtle: "#FBE6E3"
  info: "#2453D6"
  info-subtle: "#E6ECFC"
  decision: "#6B3FA0"
  decision-subtle: "#F1EAF8"
  demo: "#9A3412"
  demo-subtle: "#FDEBE1"
  viz-1: "#0E6863"
  viz-2: "#2453D6"
  viz-3: "#A86B12"
  viz-4: "#8248B8"
  viz-5: "#C2410C"
  viz-6: "#5B6670"
typography:
  display:
    fontFamily: Schibsted Grotesk
    fontSize: 28px
    lineHeight: 34px
    fontWeight: 800
  heading:
    fontFamily: Schibsted Grotesk
    fontSize: 20px
    lineHeight: 26px
    fontWeight: 600
  sans:
    fontFamily: IBM Plex Sans
    fontSize: 14px
    lineHeight: 20px
    fontWeight: 400
  mono:
    fontFamily: IBM Plex Mono
    fontSize: 12px
    lineHeight: 18px
    fontWeight: 400
rounded:
  sm: 4px
  md: 6px
  lg: 10px
  pill: 999px
spacing:
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 20px
  6: 24px
  8: 32px
  12: 48px
  16: 64px
  24: 96px
---

## Overview

LogMem is an **Operate** surface for inspecting agent shifts, answering handoffs, reviewing human-gated decisions, and auditing space logs. Both the vanilla dashboard (`public/app/`) and the Next.js dashboard (`apps/dashboard/`) follow one **Instrument Precision** visual contract governed by `public/ds/tokens/logmem.css` and `public/ds/components/bundle.css`.

## Colors

- Consume semantic CSS custom properties (`var(--*)`) exclusively in every workspace layout, page, and component. Never hardcode raw hex values in component markup or classes.
- Reserve `--brand` (teal) for primary actions, active navigation states, and direct selection cues.
- Reserve `--decision` (violet) strictly for human approval gates (`Approve`, decision badges, approval confirmation cards).
- Reserve `--focus` for visible `2px` keyboard focus rings (`outline-offset: 2px`).
- Color entry kinds only by their 6 semantic groups (`--viz-1` Work, `--viz-2` Handoff, `--viz-3` Signal, `--viz-4` Decision, `--viz-5` Error, `--viz-6` System). Unknown kinds render in neutral `--surface-sunken` with `--text-muted`.
- Always pair status colors with explicit status words so state never relies on color alone.
- Theme native browser surfaces (`::selection`, `caret-color`, `text-underline-offset`) from the palette tokens.

## Themes

Light is the default theme (`:root, [data-theme="light"]`). Dark theme activates via `[data-theme="dark"]` or `@media (prefers-color-scheme: dark)` when `data-theme="light"` is not forced.

| Token | Light (default) | Dark |
|---|---|---|
| `--bg` | `#F4F6F5` | `#0C1211` |
| `--surface` | `#FFFFFF` | `#121A19` |
| `--surface-raised` | `#FFFFFF` | `#19231F` |
| `--surface-sunken` | `#EAEEEC` | `#080D0C` |
| `--border` | `#D3DAD8` | `#2B3835` |
| `--border-strong` | `#7A8784` | `#6B7975` |
| `--text` | `#121A19` | `#E9EEEC` |
| `--text-muted` | `#46534F` | `#B3BEBA` |
| `--text-subtle` | `#5C6966` | `#97A4A0` |
| `--text-inverse` | `#F4F6F5` | `#121A19` |
| `--brand` | `#0E6863` | `#4FC3B8` |
| `--brand-hover` | `#0A524E` | `#74D2C8` |
| `--brand-subtle` | `#DDF1EE` | `#0F2D2A` |
| `--on-brand` | `#FFFFFF` | `#06201E` |
| `--focus` | `#2453D6` | `#86A6FF` |
| `--link` | `#0B5E59` | `#6FD2C7` |
| `--success` / `--success-subtle` | `#1E6B35` / `#E2F1E5` | `#5DC47C` / `#0F2618` |
| `--warning` / `--warning-subtle` | `#875100` / `#FBEED6` | `#E8A746` / `#2C1F08` |
| `--danger` / `--danger-subtle` | `#B42318` / `#FBE6E3` | `#F47A66` / `#341411` |
| `--info` / `--info-subtle` | `#2453D6` / `#E6ECFC` | `#86A6FF` / `#121C38` |
| `--decision` / `--decision-subtle` | `#6B3FA0` / `#F1EAF8` | `#C6A0F0` / `#231637` |
| `--demo` / `--demo-subtle` | `#9A3412` / `#FDEBE1` | `#F6A276` / `#32180B` |
| `--viz-1` .. `--viz-6` | `#0E6863`, `#2453D6`, `#A86B12`, `#8248B8`, `#C2410C`, `#5B6670` | `#4FC3B8`, `#86A6FF`, `#E0B04F`, `#C6A0F0`, `#F28A5B`, `#9EAAB4` |

## Typography

- Use `Schibsted Grotesk` (600/800) only for the brand lockup and page/section headings — never in UI labels, buttons, or data tables.
- Use `IBM Plex Sans` (400/500/600) for navigation, controls, cards, and prose (65–75ch measure on reading blocks).
- Use `IBM Plex Mono` (400/500) strictly for timestamps, middle-truncated IDs, counts (`font-variant-numeric: tabular-nums`), and env/config names — never as decorative styling.
- Keep fixed `px`/`rem` heading steps in Operate views rather than fluid `clamp()` sizing.

## Layout

- **Desktop shell (`>= 768px`):** Sticky left rail (`232px`) with space switcher, Brief-first primary navigation (`Brief`, `Inbox`, `Activity`, `Chat`, `Work`, `Agents`), hairline-separated secondary/role-gated links, and account footer; centered content column (`max-width: 1280px`).
- **Mobile shell (`< 768px`):** Fixed 5-tab bottom bar (`Brief`, `Inbox`, `Chat`, `Work`, `More`) with `>= 44px` touch targets and safe-area inset padding. Overflow destinations live inside an accessible `More` sheet; never pack 8+ horizontal scrolling tabs into the bottom bar.
- **Density:** Default comfortable (`36px` controls, `44px` rows, `20px` panel padding); opt-in `[data-density="compact"]` (`28px` controls, `32px` rows, `16px` padding).
- Maintain tighter spacing within related groups than between distinct sections, with more space above headings than below.

## Elevation & Depth

- Default containers sit flat on `--surface` with a crisp `1px solid var(--border)` hairline rather than heavy drop shadows.
- Reserve `--shadow-1` for interactive hover lift on linked stat tiles and cards; reserve `--shadow-2` / `--shadow-3` for popovers, drawers, and dialogs.
- Never use hard zero-blur offset shadows or colored glow halos.

## Shapes

- Use `--radius-md` (`6px`) for panels, buttons, and inputs; `--radius-sm` (`4px`) for compact tags and Copy ID pills; `--radius-lg` (`10px`) for drawers/sheets; `--radius-pill` (`999px`) for count badges and status chips.

## Components

- **PageHeader (`.lm-page-header`):** Single page title matching the active nav label and route, paired with an optional muted subtitle and right-aligned action slot. Never place an eyebrow/kicker label above the page heading.
- **StatusStrip (`.lm-status-strip`):** Single-line ~40px dismissible status bar replacing repeated multi-line banners.
- **StatTileLink (`.lm-stat-tile`):** Linked summary KPI tile with `tabular-nums`, muted zero state (`.is-zero`), and additive totals matching their underlying list.
- **CopyId (`.lm-copy-id`):** Middle-truncated monospace identifier (`handoffPr…kit`) revealing the full value on hover/title and copying on click with live `Copied` confirmation.
- **AgeBucketChips (`.lm-age-chip`):** Queue filters (`All`, `Due soon`, `Overdue`, `Over 48 h`) where empty buckets stay visible in a `disabled` state rather than disappearing.
- **KindChip (`.lm-kind-chip`):** Group-colored entry kind pill keyed to `data-group` (`work`, `handoff`, `signal`, `decision`, `error`, `system`).
- **EntryRow (`.lm-entry-row`):** Timestamp, `KindChip`, agent name, verbatim summary, and muted provenance line (`where · trail · origin · via`).
- **ReadOnlyFlag (`.lm-readonly-flag`):** Static status chip plus deploy env-var hint for non-editable settings; never rendered as a toggle switch.
- **ChatStateOrb (`.lm-orb`) & CiteChip (`.lm-cite-chip`):** 20px state orb (`working`, `reasoning`, `searching`, `retrying`, `compacting`, `waiting`) paired with status text and frozen under `prefers-reduced-motion`; clickable `[1]` inline source citation chips.
- **StatePanel:** Dedicated loading skeleton (matching final geometry), instructive empty state (naming the tool/action that populates the view), and `role="alert"` unavailable error panel.

## Do's and Don'ts

- **Do** mark every active navigation link with `aria-current="page"` and verify full keyboard traversal (`Tab`, `Enter`, `Escape`).
- **Do** keep action buttons in drawers inside a sticky footer with destructive/secondary exits (`Can't do`) styled secondary and approval actions in `--decision`.
- **Do** distinguish unavailable data (`role="alert"`) from an empty space.
- **Don't** put raw `#hex` colors in workspace pages or components.
- **Don't** render eyebrow/kicker labels above page headings or colored `border-left` stripes thicker than `1px` on cards/alerts.
- **Don't** use Unicode glyphs or emoji in place of authored SVG/Lucide icons.
- **Don't** render fake switches for read-only environment settings or print raw secrets/tokens in connection snippets.
