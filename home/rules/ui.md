---
paths: ["**/*.css","**/*.scss","**/*.tsx","**/*.jsx","**/*.vue","**/*.html","**/styles/**","**/tokens/**"]
---
# UI/UX/a11y rules: id | rule | check
U1 | Design tokens only, no raw hex/px; light and dark | stylelint
U2 | Mobile-first; check 360, 768, 1280 px | playwright
U3 | WCAG AA contrast: text 4.5:1, large and UI 3:1 | axe
U4 | Semantic HTML first; ARIA only without a native element | jsx-a11y
U5 | Keyboard operable; visible focus; logical order | playwright
U6 | Targets >=24px; non-drag alternative | axe
U7 | No cognitive-test login; allow paste | rev
U8 | Alt text; named icon buttons; aria-live status | axe
U9 | Honour reduced-motion; not color alone | rev
U10 | Show status; confirm or undo destructive acts | rev
U11 | Empty and error states give a next step | test
U12 | Plain sentence-case copy; no placeholder text | grep
U13 | Every supported locale and direction: logical CSS; phone/email/URL/code/number/card fields `dir=ltr` in RTL; mirror directional icons | ui-coverage
U14 | Reuse the design-system or sibling component for a control; a look-alike is a fail | rev, ui-coverage
