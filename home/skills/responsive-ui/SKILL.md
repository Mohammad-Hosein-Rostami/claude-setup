---
name: responsive-ui
description: Use when building or changing a page, screen, step or component layout, even a small UI tweak - mobile-first, breakpoints, container queries, touch targets, overflow at 320px, reflow.
---

Rules: U2, U6. WCAG 2.2: 1.4.10 Reflow, 2.5.8 Target Size.

1. Write base styles for the smallest screen, then add `@media (width >= 48rem)` upwards. Use `rem` for type and spacing, `clamp()` for fluid type, `min()`/`max()` and `gap` for layout; no fixed widths on containers.
2. Components that live in different places use container queries (`container-type: inline-size`, `@container (width > 40rem)`), not viewport queries.
3. Content must reflow at 320 CSS px (400% zoom) with no horizontal scroll, except data tables, maps and diagrams. Use `overflow-wrap:anywhere` on long strings, `min-width:0` on flex/grid children, `max-width:100%` on media.
4. Touch targets: at least 24x24 CSS px is the WCAG 2.2 AA floor; build 44-48 px for primary controls, with spacing between targets.
5. `<meta name="viewport" content="width=device-width, initial-scale=1">`; never `user-scalable=no` or `maximum-scale=1`. Use `dvh`/`svh` instead of `100vh` on mobile; `env(safe-area-inset-*)` with `viewport-fit=cover` for notches.
6. Do not lock orientation. Tables become stacked cards or scroll inside their own container. Hover-only actions need a tap/keyboard path.
7. Verify with the tool below instead of hand-written Playwright.

## Verify
Figma frames are anchors and must be pixel-exact (`figma-pixel-perfect`); widths in between are checked by invariants:
`node ~/.claude/tools/ui-check/cli.mjs responsive --url URL --project .` (exit 0 pass, 1 findings, 2 setup error).
Default widths 320, 360, 390, 768, 1024, 1280, 1440, 1920; add every Figma frame width to `--widths`.
It checks: no horizontal scroll, nothing outside the viewport, no clipped text, targets >= 24x24, text >= 12px
under 768. Screenshots go to disk (path in `report.md`); read the report, not the images.
Tables: `columns --url URL --table SEL`.

Check per state (open menu, dialog, error) and per locale (long strings, RTL) for the changed surfaces; the matrix is in `ui-coverage`.

Done-gate: no horizontal overflow at 320 px; primary targets >= 44 px.
