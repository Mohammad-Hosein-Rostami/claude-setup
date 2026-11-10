---
name: ui-quality-pass
description: Use when finishing any UI component or page, before calling it done.
---

Rules: F7-F9, U1-U12 (`rules/ui.md`; examples in `standards/ui-a11y.md`). Build-time detail lives in `accessibility-build`, `responsive-ui`, `async-ui-states`, `forms-validation`.

1. Tokens only: no raw hex or px; check light and dark (U1). Match the project's design system names.
2. Semantics: native elements first; ARIA only when none exists; every input labelled; icon buttons named (U4, U8, F9).
3. Keyboard: tab through the whole screen with no mouse. Focus is visible, order is logical, no trap, Esc closes overlays (U5).
4. Contrast: text 4.5:1, large text and UI parts 3:1; state is not shown by colour alone (U3, U9).
5. Responsive at 360, 768 and 1280 px: no horizontal scroll, targets >= 24px, 44px preferred on touch (U2, U6).
6. Motion: honour `prefers-reduced-motion` (U9).
7. Async states: loading, empty with next step, error with retry, success (F7, F8, U11). Destructive actions confirm or undo (U10).
8. Copy: plain sentence case, no placeholder text (U12).
9. Run axe (or the project's a11y test) and capture a screenshot at each breakpoint if a browser is already configured; otherwise state "not run".

Done-gate: checklist 1-8 each marked pass or a fix commit; axe result or "not run" stated; then `verify-done`.

Typical misses: raw hex/px, `div` with `onClick`, missing loading/empty/error states, `new Date(string)`, `100vh` on mobile, overflow at 320 px, console errors.
