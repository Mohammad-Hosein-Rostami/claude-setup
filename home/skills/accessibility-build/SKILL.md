---
name: accessibility-build
description: Use while writing or changing UI code (.tsx/.jsx/.vue/.html; MUI components, dialogs, menus, icon buttons, forms) so it is accessible from the start - semantic HTML, keyboard, focus, labels, contrast, motion (WCAG 2.2 AA).
---

Rules: U3-U9. Test with axe and, in a browser, the chrome-devtools `a11y-debugging` skill.

1. Use the native element first: `button`, `a`, `nav`, `main`, `label`, `ul`, `table`, `dialog`, `details`. ARIA only when no native element exists. Never `div` with `onClick`.
2. Everything works by keyboard: visible `:focus-visible` style, logical tab order, no positive `tabindex`, Esc closes dialogs (native `<dialog>.showModal()` gives focus trap and Esc), focus returns on close, route changes move focus to the new heading.
3. Forms: real `<label>`, errors as text linked with `aria-describedby` and announced (live region or `role="alert"`). More in `forms-validation`.
4. Contrast 4.5:1 for text, 3:1 for large text and UI parts; do not rely on colour alone. Check both themes.
5. Images have meaningful `alt` or `alt=""`; icons-only buttons have an accessible name; headings are in order.
6. Respect `prefers-reduced-motion`; nothing flashes more than 3 times a second; no content that disappears on a timer without control.
7. WCAG 2.2 additions: focus is not hidden behind sticky bars (2.4.11), drag actions have a click alternative (2.5.7), targets >= 24 px (2.5.8), no cognitive test to log in (3.3.8), no re-asking entered data (3.3.7), help in a consistent place (3.2.6).
8. Verify: eslint-plugin-jsx-a11y, axe (jest-axe / @axe-core/playwright) on each page and dialog, a keyboard-only run of the main journey. Automation finds only part of the issues: do the manual pass.

Done-gate: axe clean, keyboard journey passes, labels and focus handled.
