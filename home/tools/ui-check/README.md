# ui-check

Figma-to-browser checks for pixel-exact frames and responsive layouts. Node ESM, no build step.
Playwright is not a dependency: it is resolved from the target project (`--project`, default cwd).

Install: `npm ci` in this folder (only package-lock.json exists; Node >= 22); `scripts/install.sh` does it.
Run: `node ~/.claude/tools/ui-check/cli.mjs <command> [flags]`.

Exit codes: `0` pass, `1` check failed, `2` usage or setup error (bad flag, no Playwright/Chromium/odiff,
no `FIGMA_TOKEN`, unreachable URL or HTTP status >= 400).

## Commands

| Command | Flags | What it does |
| ------- | ----- | ------------ |
| `figma-pull` | `--file KEY --node ID [--scale 1] [--refresh]` | Needs env `FIGMA_TOKEN`. Writes `baseline.png`, `spec.json`, `meta.json` to `~/.cache/figma/<KEY>/<ID>/` (`:` in IDs becomes `-`). Skips the fetch if cached. |
| `compare` | `--url U --root SEL --cache DIR [--map map.json] [--steps steps.json] [--bypass-csp] [--max-diff 0.5] [--out DIR]` | Viewport = frame size, DSF = scale. Element gate (box +-1px, font, line-height, letter-spacing, colour, background, radius, padding, gap) then pixel gate (odiff, threshold 0.1, anti-aliasing ignored; size mismatch is reported first and both images are padded). |
| `responsive` | `--url U [--widths 320,...,1920] [--height 900] [--steps steps.json] [--bypass-csp] [--out DIR]` | Per width: horizontal scroll, elements outside the viewport, clipped text, tap targets < 24x24, text < 12px under 768. Screenshots `w<width>.png` stay on disk. |
| `columns` | `--url U --table SEL [--width 1440]` | Body cells vs header cells: left delta <= 1px, width delta <= 2px. |

Output (`--out`, default `<cache>/runs/<timestamp>` for compare, the OS temp dir otherwise): `report.json`,
`report.md` (<= 40 lines), `actual.png`, `diff.png` (absent on an exact match).

`map.json` maps Figma node ids from `spec.json` to CSS selectors: `{"1:2": "[data-testid=title]"}`.

## Opt-in flags (`compare`, `responsive`)

- `--bypass-csp`: Playwright `bypassCSP` for the run, so a page CSP does not block the injected freeze style (without it
  such a page makes the run exit 2). Off by default; with the flag absent nothing changes. Test-only: the flow e2e
  should still run with CSP on, so a real CSP violation is still caught there.
- `--steps steps.json`: interaction steps run after the page settles and before the freeze style and capture, once per
  page (per width for `responsive`), to measure a state (hover, focus, filled or errored form). The file is a JSON
  array validated against a fixed action list (nothing is evaluated); a bad shape, an unknown action, or a selector
  matching other than exactly one element exits 2 naming the step. Tolerances and gates are unchanged.

  ```json
  [{"action": "fill", "selector": "#email", "value": "a@b.c"}, {"action": "press", "selector": "#email", "key": "Tab"},
   {"action": "hover", "selector": "button[type=submit]"}, {"action": "wait", "ms": 200}]
  ```

  Actions: `fill`/`select` (`selector`, `value`), `press` (`selector`, `key`), `click`/`check`/`uncheck`/`focus`/`hover`/`waitFor`
  (`selector`), `blur` (no fields; blurs the active element), `wait` (`ms` >= 0). Each step times out after 5 s; `wait` is capped at 30000 ms; unknown fields are rejected. A step does not auto-wait for its element to exist (exactly one match is required at once), so put `waitFor` before it when the element renders late. `waitFor` needs a visible element (or an attribute on one, e.g. `html[data-ready]`): a zero-size marker times out.

Tolerances live in `lib/tolerances.mjs` and are documented in `standards/figma.md`.

## Tests

`pnpm test` runs the unit tests. Set `UI_CHECK_PROJECT=/path/to/project-with-playwright` to also run the
browser smoke test (fixture compare pass/fail and a 500px box at 320).

## Layout

`cli.mjs` dispatch; `commands/*` one file per command; `lib/*` small modules (spec flattening, cache, Figma
REST, browser setup, in-page measure/audit, element comparison, pixel gate, report).
