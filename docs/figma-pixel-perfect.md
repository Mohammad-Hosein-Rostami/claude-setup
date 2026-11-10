# Figma to code, pixel-exact and responsive

Goal: exact at each Figma frame size, valid by invariants at every width in between, with few MCP calls and no
screenshots in the model's context. Skill: `figma-pixel-perfect`. Rules and tolerances: `home/standards/figma.md`.
Tool: `home/tools/ui-check/` (README beside it). Agent for the loop: `visual-qa`.

    UI="node ~/.claude/tools/ui-check/cli.mjs"

## 1. Pull the baseline (once per frame)
    export FIGMA_TOKEN=...            # see docs/setup.md; never echo it
    $UI figma-pull --file <fileKey> --node 12:34 --scale 1

Cache: `~/.cache/figma/<fileKey>/12-34/` (colon becomes dash)
- `baseline.png`: Figma export at the scale, exact bounds (`use_absolute_bounds=true`).
- `spec.json`: root plus a flat node list; `x y w h` relative to the root; text style (fontSize, fontWeight,
  lineHeightPx, letterSpacing px, colour); box style (background, radius, padding, `gap`, `figmaItemSpacing`,
  `derivedGaps`, layoutMode). `gap` is derived from sibling coordinates, not trusted from Figma.
- `meta.json`: `{ fileKey, nodeId, scale, width, height, fetchedAt }`.

Re-running skips the fetch; add `--refresh` after the design changes.

No token: MCP fallback. Call `get_metadata` (geometry), `get_variable_defs` (tokens) and `get_screenshot` (save as
`baseline.png`), then write `spec.json` and `meta.json` in the same shape (see `home/tools/ui-check/test/fixtures/frame.json`
for the Figma node shape `spec.json` is flattened from, and `flattenSpec` in `lib/spec.mjs`).

## 2. Implement
`get_design_context` once per node only when structure is unclear. Map values to Code Connect components and MUI
theme tokens. Add stable selectors (`data-testid`) to the elements you want checked.

## 3. map.json
Keys are node ids from `spec.json`; values are CSS selectors (the root may be mapped too). Only mapped nodes are
checked, and only props present in the spec.

    { "12:34": "[data-testid=card]",
      "12:35": "[data-testid=card-title]",
      "12:40": "[data-testid=card-action]" }

## 4. Compare
    $UI compare --url http://localhost:4200/page --root "[data-testid=card]" \
        --cache ~/.cache/figma/<fileKey>/12-34 --map map.json --project .

The viewport is set to the frame size and the device scale factor to the scale. The page is frozen (fonts ready,
images loaded, animations off, caret hidden, reduced motion). Two gates, both must pass:
- Element gate: box vs root +-1px, font-size, weight, line-height, letter-spacing, colour, background, radius,
  padding, gap (tolerances in `standards/figma.md`).
- Pixel gate: odiff, threshold 0.1, anti-aliasing ignored, fails above `--max-diff` (% of pixels, default 0.5).
  A size mismatch is reported first, then both images are padded and diffed anyway.

Output in `<cache>/runs/<timestamp>/` (or `--out`): `report.md` (<= 40 lines: verdict, diff %, diff region,
failing `element | prop | is | should | delta`), `report.json`, `actual.png`, `diff.png`.
Exit 0 pass, 1 fail, 2 setup error.

## 5. Fix loop
Fix only the failing rows, one root cause per round (fonts first, then layout, then tokens). At most 3 rounds, then
report what is left and why. Never raise `--max-diff` to pass. The false-positive list is in `standards/figma.md`.

## 6. Responsive
    $UI responsive --url http://localhost:4200/page --widths 320,360,390,768,1024,1280,1440,1920,<frame widths>
    $UI columns --url http://localhost:4200/page --table "[data-testid=orders-table]"

Per width: no horizontal scroll, nothing outside the viewport, no clipped text (`scrollWidth > clientWidth`
without ellipsis), tap targets >= 24x24 (WCAG 2.5.8; inline links exempt), text >= 12px under 768. Screenshots
`w<width>.png` stay on disk. `columns` checks body cells against header cells (left <= 1px, width <= 2px).

## Delegating
Give the `visual-qa` agent the URL, root, cache dir, map and project. It returns <= 20 lines and the report path.
Tell it to fix only if you want the loop run.
