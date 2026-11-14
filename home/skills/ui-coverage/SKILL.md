---
name: ui-coverage
description: Use for any UI task with more than one component, any Figma or pixel-perfect work, any "all screens / all forms / everywhere" request, and any i18n or RTL work - build a coverage matrix of surfaces x states x locales, gate it with ui-coverage check, hand over a live page.
---

Rules: U13, U14, U1, U2. Tool: `node ~/.claude/tools/ui-coverage/ui-coverage.mjs <expand|check>` (README beside it has the matrix.json format). The matrix is one file per task; done = `check` exits 0.

1. **Surfaces.** Design frames + app routes + HIDDEN UI: grep the backend and sibling repos for templates (email, mjml, hbs, ejs, pug, jinja, tmpl, html strings, PDF, notifications, server error / redirect / consent pages). Record each search command and its hit count in `searched` (proof it ran, even at 0 hits). A frame with no code home is built, listed with a reason, or asked about once; never defaulted.
2. **Controls and reuse.** For each control class (select, checkbox, radio, switch, text field, phone, button, dialog, toast...) find the existing component in the project's design system and in sibling apps/zones; record its path in `component`. `{new: reason}` needs a real reason. A look-alike of an existing component is a fail (U14).
3. **States per control** (drop one only with a reason in `dropped`): select/dropdown/menu/autocomplete: rest, focus, open, option-hover, selected, disabled, error. checkbox/radio/switch: unchecked, checked, indeterminate, focus, disabled, error. text field: empty, focus, filled, error, success, disabled. button: rest, hover, focus, active, disabled, loading. overlays (dialog, toast, tooltip, popover): shown. async surface: loading, empty, error. A state the harness cannot render is a gap to list (`deferred` + reason), not a skip.
4. **Locales and direction.** Read the supported locales from the i18n config; every one is in `locales`. RTL (U13): logical CSS properties; phone, email, URL, code, number and card fields stay `dir="ltr"` inside RTL; directional icons mirror; long strings do not clip; a font per script.
5. **Reference behaviour.** When the same fields exist in a reference app or API, read its validators first and match them; put the path in `reference`, or `none: <reason>`.
6. **Gate.** `expand matrix.json`, write one state file for `ui-check batch --states states.json` (writes results.json), then `check matrix.json --results results.json`. Fix and re-run until it exits 0. Only `pass` with evidence, or `na` / `deferred` with a reason, count.
7. **Deliverable.** A live review page (served route or static HTML built from the real components, with state and locale switches), never screenshots alone. Dev-only mocks and showcases are proven absent from the production build: build, grep the output, quote the result in `deliverable.mockExcluded`.
8. **Report to the owner.** Paste the tool summary, including every `na` and `deferred` cell with its reason.
9. **Timed-out question.** A scope or component question that gets no answer: take the option that keeps the full scope and reuses the existing component; log it as taken by default.

Done-gate: `ui-coverage check` exits 0 (summary pasted); live page URL given; mock-exclusion output quoted; then `ui-quality-pass` and `verify-done`.
