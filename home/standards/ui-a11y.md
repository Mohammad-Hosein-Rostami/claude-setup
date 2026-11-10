# UI, UX, accessibility (U1-U12)

- **U1** Colors, spacing, type, radius, shadow, motion come from tokens; both light and dark work.
- **U2** Build mobile-first; verify at 360, 768 and 1280 px.
- **U3** WCAG 2.2 AA contrast: 4.5:1 text, 3:1 large text and UI parts.
- **U4** Use button, a, nav, main, label and ordered headings; ARIA only when no native element exists.
- **U5** Everything works by keyboard, focus is visible and not hidden by sticky bars (2.4.11).
- **U6** Targets at least 24x24 CSS px (2.5.8); give a non-drag alternative (2.5.7).
- **U7** No puzzle-only login, allow paste and password managers (3.3.8), don't re-ask entered data (3.3.7).
- **U8** `alt` on images (empty if decorative), accessible names on icon buttons, `aria-live` for status.
- **U9** Respect prefers-reduced-motion and prefers-color-scheme; never color alone.
- **U10** Nielsen: show status, speak the user's language, confirm or offer undo for destructive acts, helpful errors.
- **U11** Empty state explains and offers the next action; errors say what happened and how to recover; skeletons over spinners past 400 ms.
- **U12** Plain sentence-case copy, consistent terms, no lorem ipsum.
