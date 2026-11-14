# Figma to code conversion (used by `figma-pixel-perfect`, checked by `ui-check`)

Frames are anchors: pixel-exact at the Figma frame size, invariants only (see `responsive-ui`) in between.

## Figma to CSS
- **Letter-spacing:** the REST API gives px; MCP/Dev Mode may show %. CSS `letter-spacing` in `em` = % / 100. Keep px or `em`, never both.
- **Line-height:** use the explicit px value (`lineHeightPx`). Figma "Auto" is the font's metric height, not CSS `normal`; `normal` is reported as a failure.
- **Text box vs line box:** a Figma text box is its line box (`lineHeightPx` x lines). Set `line-height`, not padding, to match height. Hug text = `width: fit-content`.
- **Auto layout to flex:** direction = `layoutMode`; `itemSpacing` = `gap`; padding = padding. Hug = `width: fit-content` (or auto), Fill = `flex: 1 1 0; min-width: 0`, Fixed = explicit size plus `flex-shrink: 0`. Space-between has no gap: use `justify-content`.
- **Derived gaps:** do not trust a reported `gap`. `spec.json` computes `gap` from sibling coordinates (next start minus previous end); `figmaItemSpacing` is the raw value. Read `derivedGaps` when they differ.
- **Sub-pixel rounding:** Figma boxes can be fractional; browsers snap layout to 1/64 px and paint to device pixels. Tolerate 1px on boxes, 0 on tokens. Do not round values in CSS to chase 0.5px.
- **Effects:** drop shadow = `box-shadow` x y blur spread colour (Figma blur = CSS blur, not 2x); inner shadow = `inset`; layer blur = `filter: blur()`; background blur = `backdrop-filter`. Strokes: inside = `box-sizing: border-box` border, outside = `outline`/`box-shadow` spread.
- **Fonts:** match family, weight and style; load with `font-display: swap` and wait for `document.fonts.ready` before measuring. A fallback font changes every text metric: fix the font before anything else.
- **Text baseline and smoothing:** Figma snaps each baseline to `round(L/2 + 0.35 x size)` px below the line top (L = line height); Blink rounds ascent and descent separately, so text sits 1px higher at some size/line-height pairs (Poppins: 10/16, 13/18, 13/20, 16/22, 22/28, 28/42). Fix it once in shared CSS with a font-specific `descent-override` in each `@font-face` (Poppins: 33.4%; derive it per font, a band of a few tenths of a percent works for the sizes in use) and set `-webkit-font-smoothing: antialiased` (plus `-moz-osx-font-smoothing: grayscale`) on `html`, since macOS stem darkening thickens glyphs Figma draws plain. Never nudge single elements by 1px. What remains (about 0.016% of pixels in the Poppins case) is glyph rasterisation by the renderer: report it as an open item with evidence.

## Mapping to the project
- Resolve each value in this order: Code Connect component, MUI theme token (`palette`, `typography` variant, `spacing`, `shape.borderRadius`), then a named constant. A raw px or hex needs a one-line reason.
- Check the project's spacing unit before converting px to `theme.spacing(n)`; do not assume 8px.
- Extend the theme when a value recurs 3 times; otherwise use the component variant.

## Interactive states
Read the states from the frame, not from the screen's name: fill and text colour tokens, a floated label, an affordance (chevron). Check every variant in the file, not only the frame you were given. The default states per control class (select, checkbox/radio/switch, text field, button, overlays, async surfaces) are listed once, in `tools/ui-coverage/lib/states.mjs` (`ui-coverage.mjs states` prints them); each state is a row in the `ui-coverage` matrix. Missing backend is never a reason to set `disabled`.

## Tolerances (`lib/tolerances.mjs`)
| What | Tolerance | Gate |
| ---- | --------- | ---- |
| Box x, y, w, h vs root | 1 px | element |
| font-size, line-height | 0.5 px | element |
| letter-spacing | 0.1 px | element |
| padding, gap | 0.5 px | element |
| radius (clamped to half the box) | 0.5 px | element |
| colour | 1 per channel, alpha 0.02 | element |
| pixel diff | `--max-diff`, default 0.5 % of pixels (odiff threshold 0.1, anti-aliasing ignored) | pixel |

Plateau (two rounds, no gain): change approach, never lower the bar; see `agents/visual-qa.md`.

Tune `--max-diff` up only for a documented cause (live images, video); never to hide layout. Raise per-run, not in the tool. A larger frame with the same defect diffs less, so keep the element gate on.

## False positives (document, do not chase)
- Font anti-aliasing and sub-pixel text positioning (Skia vs Figma renderer): small diff on glyph edges, no box deltas.
- Blur and shadow rendering: a soft halo differing by a few levels.
- Image compression and scaling of photos and avatars.
- Sample content (names, dates) differing from the placeholder text in the frame: seed fixtures or mask.
- Scrollbars, caret, focus rings, animations: the tool freezes animation and hides the caret; set the page up in the same state as the frame.
- Overlaying a content-only frame on a full page (sidebars, nav): compare the frame root, not the page.

If the element gate passes and only edge pixels differ at under the threshold, stop and report.
