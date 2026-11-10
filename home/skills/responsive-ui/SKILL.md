---
name: responsive-ui
description: Use when building or changing any page or component layout - mobile-first CSS, breakpoints, container queries, touch targets, viewport, reflow.
---

Rules: U2, U6. WCAG 2.2: 1.4.10 Reflow, 2.5.8 Target Size.

1. Write base styles for the smallest screen, then add `@media (width >= 48rem)` upwards. Use `rem` for type and spacing, `clamp()` for fluid type, `min()`/`max()` and `gap` for layout; no fixed widths on containers.
2. Components that live in different places use container queries (`container-type: inline-size`, `@container (width > 40rem)`), not viewport queries.
3. Content must reflow at 320 CSS px (400% zoom) with no horizontal scroll, except data tables, maps and diagrams. Use `overflow-wrap:anywhere` on long strings, `min-width:0` on flex/grid children, `max-width:100%` on media.
4. Touch targets: at least 24x24 CSS px is the WCAG 2.2 AA floor; build 44-48 px for primary controls, with spacing between targets.
5. `<meta name="viewport" content="width=device-width, initial-scale=1">`; never `user-scalable=no` or `maximum-scale=1`. Use `dvh`/`svh` instead of `100vh` on mobile; `env(safe-area-inset-*)` with `viewport-fit=cover` for notches.
6. Do not lock orientation. Tables become stacked cards or scroll inside their own container. Hover-only actions need a tap/keyboard path.
7. Verify: Playwright at 320, 360, 768, 1280: `document.documentElement.scrollWidth <= innerWidth`, no clipped text, targets measured with `boundingBox()`.

Done-gate: no horizontal overflow at 320 px; primary targets >= 44 px.
