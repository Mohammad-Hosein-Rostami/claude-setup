---
name: ui-quality-pass
description: Use before saying any UI component, page, screen, step or dialog is done or fixed, including small tweaks and work a subagent did - tokens, semantics, keyboard, contrast, responsive, async states, copy.
---

Runs only when the owner turned `ui` on with `/check` (a Figma link or "pixel perfect" does not turn it on). Off: build to the UI rules as you write and say `not checked: ui`.

Rules: F7-F9, U1-U12 (`rules/ui.md`; examples in `standards/ui-a11y.md`). Build-time detail lives in `accessibility-build`, `responsive-ui`, `async-ui-states`, `forms-validation`.

1. Tokens only: no raw hex or px; check light and dark (U1). Match the project's design system names.
2. Semantics: native elements first; ARIA only when none exists; every input labelled; icon buttons named (U4, U8, F9).
3. Keyboard: tab through the whole screen with no mouse. Focus is visible, order is logical, no trap, Esc closes overlays (U5).
4. Contrast: text 4.5:1, large text and UI parts 3:1; state is not shown by colour alone (U3, U9).
5. Responsive: run `ui-check responsive` (see `responsive-ui`); targets 44px preferred on touch (U2, U6). Built from a Figma frame: run `figma-pixel-perfect` first.
6. Motion: honour `prefers-reduced-motion` (U9).
7. Async states: loading, empty with next step, error with retry, success (F7, F8, U11). Destructive actions confirm or undo (U10). Cold-load each entry URL per user state with a slow session response: loader, then the one right screen, no other screen in between (`async-ui-states` 7-8).
8. Copy: plain sentence case, no placeholder text (U12).
9. Run axe (or the project's a11y test) and use `ui-check responsive` for breakpoints (reports, not screenshots) if Playwright is available; otherwise state "not run".

Done-gate: checklist 1-8 each marked pass or a fix commit; `ui-coverage check` exits 0 (paste the summary) for multi-component or multi-locale work; dev-only mocks/showcases proven absent from the production build (build, grep the output, quote it); axe result or "not run" stated; then `verify-done`.

Typical misses: raw hex/px, `div` with `onClick`, missing loading/empty/error states, `new Date(string)`, `100vh` on mobile, overflow at 320 px, console errors, a wrong screen shown for a moment before a redirect.
