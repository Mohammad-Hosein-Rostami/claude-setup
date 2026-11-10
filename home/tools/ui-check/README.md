# ui-check

Figma-to-browser checks for pixel-exact frames and responsive layouts. Node ESM, no build step.
Playwright is not a dependency: it is resolved from the target project (`--project`, default cwd).

Install: `pnpm install --frozen-lockfile` (or `npm ci`) in this folder; `scripts/install.sh` does it.
Run: `node ~/.claude/tools/ui-check/cli.mjs <command> [flags]`.

Exit codes: `0` pass, `1` check failed, `2` usage or setup error (bad flag, no Playwright/Chromium/odiff,
no `FIGMA_TOKEN`, unreachable URL).

## Commands

| Command | Flags | What it does |
| ------- | ----- | ------------ |
| `figma-pull` | `--file KEY --node ID [--scale 1] [--refresh]` | Needs env `FIGMA_TOKEN`. Writes `baseline.png`, `spec.json`, `meta.json` to `~/.cache/figma/<KEY>/<ID>/` (`:` in IDs becomes `-`). Skips the fetch if cached. |
| `compare` | `--url U --root SEL --cache DIR [--map map.json] [--max-diff 0.5] [--out DIR]` | Viewport = frame size, DSF = scale. Element gate (box +-1px, font, line-height, letter-spacing, colour, background, radius, padding, gap) then pixel gate (odiff, threshold 0.1, anti-aliasing ignored; size mismatch is reported first and both images are padded). |
| `responsive` | `--url U [--widths 320,...,1920] [--height 900] [--out DIR]` | Per width: horizontal scroll, elements outside the viewport, clipped text, tap targets < 24x24, text < 12px under 768. Screenshots `w<width>.png` stay on disk. |
| `columns` | `--url U --table SEL [--width 1440]` | Body cells vs header cells: left delta <= 1px, width delta <= 2px. |

Output (`--out`, default `<cache>/runs/<timestamp>` for compare, the OS temp dir otherwise): `report.json`,
`report.md` (<= 40 lines), `actual.png`, `diff.png` (absent on an exact match).

`map.json` maps Figma node ids from `spec.json` to CSS selectors: `{"1:2": "[data-testid=title]"}`.
Tolerances live in `lib/tolerances.mjs` and are documented in `standards/figma.md`.

## Tests

`pnpm test` runs the unit tests. Set `UI_CHECK_PROJECT=/path/to/project-with-playwright` to also run the
browser smoke test (fixture compare pass/fail and a 500px box at 320).

## Layout

`cli.mjs` dispatch; `commands/*` one file per command; `lib/*` small modules (spec flattening, cache, Figma
REST, browser setup, in-page measure/audit, element comparison, pixel gate, report).
