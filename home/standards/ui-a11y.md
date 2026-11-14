# UI, UX, accessibility (U1-U14)

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
- **U13** Direction and locale: every supported locale is built and checked, RTL ones included (matrix: `ui-coverage`).
- **U14** Reuse the existing design-system or sibling-app component for each control class; a look-alike is a fail.

## Direction (U13)
- Use logical properties (`margin-inline-start`, `padding-inline`, `inset-inline-end`, `text-align: start`, `border-start-*`), never `left`/`right`; set `dir` on `<html>` from the locale.
- Only the typed VALUE of a phone-like field is left-to-right. The placeholder is translated text: it follows the page direction and alignment, like the label, hint, error and the order of adornments. Make the field left-to-right only while it holds a value (e.g. `input:not(:placeholder-shown) { direction: ltr }`, which needs a `placeholder` attribute; a `type=tel` input is left-to-right by browser default in Chromium, so add `input:placeholder-shown { direction: inherit }`). `dir="ltr"` on the input itself is right only when the field has no translated placeholder; never on the wrapper. Take the value's alignment from the design; ask when the design has no RTL frame. Check both states, empty and filled (type a value), in every RTL locale; `ui-check` only hints on an empty field. Use `<bdi>` or `dir="auto"` for user-supplied names in mixed text.
- Left-to-right in every language: typed values of phone, email, URL, OTP and codes, card number, IBAN, IP address, file path, version; the same kinds SHOWN inside an RTL sentence, isolated with `<bdi dir="ltr">` or an element with `dir="ltr"`; code samples; brand names in Latin script.
- Decide with the owner or the design, do not assume: user name, password, postal code, plain numbers and amounts (a locale with its own digits may show them in the language's digits; the digit string still reads left to right).
- Never mirrored: logos, media controls, clocks, charts with a numeric axis, phone keypads, check marks. When unsure whether a value follows the language, ask.
- Every open state is translated too: option lists, menus, autocomplete, pickers, tooltips, toasts, validation text. Name where the option labels come from (constants, API, i18n file) and translate them there.
- Mirror icons that show direction (back, forward, chevron, progress, send); never mirror logos, media controls or clocks. Flip order of leading/trailing adornments (country prefix, clear button) with flex/grid, not per-locale CSS.
- Strings grow (German, Persian run 30-40% longer than English): no fixed-width labels or buttons; wrap or truncate with a tooltip, never clip silently.
- One font stack per script (Latin, Arabic/Persian, CJK) with a size/line-height that fits its glyph height; check digits (Latin, Arabic-Indic, Persian) in inputs and validators.
- Verify each surface in every supported locale, LTR and RTL, at every width and in every state of the matrix.
