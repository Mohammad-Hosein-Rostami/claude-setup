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
| `compare` | `--url U --root SEL --cache DIR [--map map.json] [--steps steps.json] [--bypass-csp] [--no-autofocus] [--max-diff 0.5] [context flags] [--out DIR]` | Viewport = frame size, DSF = scale. Element gate (box +-1px, font, line-height, letter-spacing, colour, background, radius, padding, gap) then pixel gate (odiff, threshold 0.1, anti-aliasing ignored; size mismatch is reported first and both images are padded). |
| `responsive` | `--url U [--widths 320,...,1920] [--height 900] [--steps steps.json] [--bypass-csp] [--no-autofocus] [context flags] [--out DIR]` | Per width: horizontal scroll, elements outside the viewport, clipped text, tap targets < 24x24, text < 12px under 768, `bidi-field` (below). Screenshots `w<width>.png` stay on disk. |
| `batch` | `--states file.json [--only surface[,surface]] [--out DIR]` | Many states in one run (below). `compare` for a state with `figma`, `responsive` for a state with widths. |
| `columns` | `--url U --table SEL [--width 1440] [--no-autofocus]` | Body cells vs header cells: left delta <= 1px, width delta <= 2px. |

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

## Locale, direction, colour scheme (`compare`, `responsive`, `batch`)

Context flags, all opt-in. With none given a run is exactly as before (no locale, light, nothing set, no direction check).
Every value is validated before the browser starts; an unknown value exits 2 naming the flag.

- `--locale <bcp47>`: browser context locale (`navigator.language` and `Accept-Language`), e.g. `fa-IR`. A malformed tag exits 2; the tag is recorded in its canonical form (`fa-ir` becomes `fa-IR`).
- `--color-scheme light|dark`: `prefers-color-scheme` (default `light`).
- `--storage key=value` (repeatable): `localStorage` entries set before the page's scripts run, only on the `--url` origin (a redirect to another origin gets nothing), and only once per tab: a reload does not overwrite what the app stored since, so a language switch by click and reload sticks. The value is everything after the first `=`.
- `--cookie key=value` (repeatable): cookies for the `--url` host; needs an `http(s)` URL. Cookies are scoped by host, not port: a redirect to another port of the same host sends them too. The name must be a valid cookie token and the value must not contain `;`.
- `--expect-dir ltr|rtl`: after load and steps, exit 2 with `--expect-dir rtl: the computed direction is ltr ...` when the computed `direction` of `document.documentElement` differs. It proves the language switch really happened, so a pass is not an LTR page measured by mistake. Put it together with `--storage`/`--cookie`/`--steps` that switch the language.

Finding `bidi-field` (`responsive`): in a document whose computed direction is rtl, a visible `input`/`textarea` whose `type` is `tel`/`email`/`url`/`number`, or `inputmode` is `numeric`/`decimal`/`tel`/`email`/`url`, or `autocomplete` contains `tel`/`email`/`url`/`one-time-code`/`cc-number`/`postal-code`, and whose own computed `direction` is rtl. The value reads left to right, so set `dir="ltr"` on the field (alignment may stay at the start edge). Chromium's built-in style already makes a bare `type=tel` input ltr, so there it fires for `email`/`url`/`number`/`inputmode`/`autocomplete` fields, and for `tel` only when page CSS forces rtl (e.g. `direction: inherit`; fix that rule, an attribute does not beat it). One finding per field per width.

Hint `bidi-field?` (`responsive`): the same document and field direction, but the field has no type/inputmode/autocomplete hint, is a plain text field (`type=text` or none, or a textarea), and its `name`, `id`, `autocomplete` or `aria-label` matches `/phone|mobile|tel|otp|code|email|url|iban|card/i`. It is listed in the report and in `findings`, but never fails the run (verdict and exit code ignore it).

## `batch`

`ui-check batch --states states.json [--out DIR] [--only surface[,surface]]` measures many states in ONE run: one browser, a fresh context per state, sequential, and a failing state never stops the run. The file is validated before anything launches; an error names the state index and field (`states[2].locale: ...`), and unknown fields are rejected.

```json
{
  "defaults": { "baseUrl": "http://localhost:3000", "locale": "en", "colorScheme": "light", "widths": [320, 1024],
                "storage": { "lang": "en" }, "cookies": {} },
  "states": [
    { "surface": "login", "state": "rtl-dropdown-open", "locale": "fa-IR", "url": "/login", "expectDir": "rtl",
      "storage": { "lang": "fa" }, "steps": [{ "action": "click", "selector": "#language-menu" }, { "action": "waitFor", "selector": "#language-list" }] },
    { "surface": "home", "state": "default", "url": "/", "widths": [390],
      "figma": { "file": "FILEKEY", "node": "1:2", "map": "home-map.json", "root": "#home" } }
  ]
}
```

- `defaults` (all optional): `baseUrl` (a state `url` is resolved against it), `locale`, `colorScheme`, `widths`, `storage`, `cookies` (objects of string values). A state's own `locale`, `widths` replace the default; its `storage`/`cookies` are merged by key over the default's.
- State: `surface`, `state`, `url` required. `steps` is an array (same actions as `--steps`) or a path to a steps file, relative to the states file. `figma` is `{file, node}` (the cache `figma-pull` filled), plus optional `map` (path relative to the states file) and `root` (selector, default `body`; the compare screenshot and size gate use it). A state needs `figma` or widths. `surface` + `state` + `locale` must be unique.
- `compare` runs for a state with `figma` (tolerances as the `compare` command, `--max-diff` default), `responsive` for a state with widths (default widths apply to every state, figma or not); both run when both are present. `--only` keeps the listed surfaces; a list that mixes known and unknown surfaces exits 2 naming the unknown one.
- A state that throws (bad step, HTTP error, `expectDir` mismatch, missing Figma cache) becomes failing records with the error as the finding, and the run goes on.
- A hint finding (`bidi-field?`) keeps a record `pass`.
- Zero states to run (empty `states` array, or `--only` matching no surface) prints why on stderr, writes `results.json` as `[]` and a FAIL `summary.md`, and exits `1`.
- `results.json` and `summary.md` of an earlier run in the same `--out` are deleted at the start, so a failed or empty run never leaves stale passes.
- Exit `1` when any record fails or none ran, `2` for a bad flag or states file, else `0`.

Output in `--out` (default under the OS temp dir): `results.json`, `summary.md` (one table row per state x width), and per state a folder `<index>-<surface>--<state>--<locale>/{compare,responsive}/` with the usual `report.*` and screenshots. The state folder always exists; when a part throws, its stack is in `<part>.error.txt` there (also a context that fails to close, which turns that part's records into failures). `results.json` is an array of records read by `ui-coverage check --results`; the field names are a contract:

```json
{ "surface": "login", "state": "rtl-dropdown-open", "locale": "fa-IR", "width": 320, "status": "fail",
  "evidence": "/tmp/ui-check/batch/<run>/0-login--rtl-dropdown-open--fa-IR/responsive/report.md",
  "findings": [{ "check": "bidi-field", "element": "input#otp", "detail": "..." }] }
```

`width` is the audited width, or `null` for the compare record (its viewport is the Figma frame). `locale` is `null` when none was set. `evidence` is the state's report, or the state folder when the state threw before a report existed.

## Deterministic capture (default, all commands)

Chromium is launched with `--use-angle=swiftshader --disable-gpu-rasterization` (CPU tile rasterisation: the GPU path
gave 1-3 level edge noise between runs), and an `[autofocus]` element is focused explicitly before steps and capture
(Chromium skips `autofocus` in about one load in seven, which flips the focus ring). Repeatability is part of the bar;
tolerances and gates are unchanged. Screenshots taken before this change are not comparable with new ones: re-record
baselines and references once.

Scope: the fix targets the HTML `autofocus` attribute, which Chromium skips on some loads. React `autoFocus` focuses from
JavaScript, emits no attribute and is unaffected (nothing to fix, nothing changes). Pass `--no-autofocus` (`compare`,
`responsive`, `columns`) when the Figma frame shows the unfocused state: the field is then left as the page loaded it.

Tolerances live in `lib/tolerances.mjs` and are documented in `standards/figma.md`.

## Tests

`pnpm test` runs the unit tests. Set `UI_CHECK_PROJECT=/path/to/project-with-playwright` to also run the
browser smoke test (fixture compare pass/fail and a 500px box at 320), the Chromium checks in `determinism.test.mjs`, and
`locale-browser.test.mjs` (bidi-field, `--expect-dir`, storage, locale, cookie, `batch`; it briefly writes a fixture Figma cache under `~/.cache/figma/ui-check-batch-test-<pid>` and removes it).

## Layout

`cli.mjs` dispatch; `commands/*` one file per command (`batch` reuses `compare` and `responsive`); `lib/*` small modules (spec flattening, cache, Figma
REST, browser setup, in-page measure/audit, element comparison, pixel gate, report).
