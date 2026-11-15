# ui-check

Figma-to-browser checks for pixel-exact frames and responsive layouts. Node ESM, no build step.
Playwright is not a dependency (see "Finding Playwright" below).

Install: `npm ci` in this folder (only package-lock.json exists; Node >= 22); `scripts/install.sh` does it.
Run: `node ~/.claude/tools/ui-check/cli.mjs <command> [flags]`.

Exit codes: `0` pass, `1` check failed, `2` usage or setup error (bad flag, no Playwright/Chromium/odiff,
no `FIGMA_TOKEN`, unreachable URL or HTTP status >= 400).

## Finding Playwright

Looked up in this order, the first that resolves `playwright`, `@playwright/test` or `playwright-core` wins; a place that has none is skipped:

1. `--project DIR` (when the flag is absent: the current directory, as before),
2. env `UI_CHECK_PROJECT`,
3. the tool's own `node_modules` (this folder, and the `node_modules` folders above it).

When none has it, exit 2 with a message that lists each place tried and two fixes: set `UI_CHECK_PROJECT=<folder whose node_modules has playwright>` (or pass `--project`), or give the tool its own copy with
`npm install --no-save --prefix <this folder> playwright` then `<this folder>/node_modules/.bin/playwright install chromium`. The tool installs nothing itself and `package.json` has no Playwright entry, so a fresh `npm ci` here does NOT give the tool its own copy.
The browser binary is found by Playwright itself in its cache (`~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright`, `%LOCALAPPDATA%\ms-playwright`, or `PLAYWRIGHT_BROWSERS_PATH`) by the revision the Playwright version needs: any copy works as long as its Chromium revision is in that cache.

## Commands

| Command | Flags | What it does |
| ------- | ----- | ------------ |
| `figma-pull` | `--file KEY --node ID [--scale 1] [--refresh]` | Needs env `FIGMA_TOKEN`. Writes `baseline.png`, `spec.json`, `meta.json` to `~/.cache/figma/<KEY>/<ID>/` (`:` in IDs becomes `-`). Skips the fetch if cached. |
| `figma-frames` | `--file KEY --node ID [--node ID]... --out frames.json` | Needs env `FIGMA_TOKEN`. One REST call per `--node` (nodes endpoint, depth 2); a node id in the URL form `12-40` is sent as `12:40`. A frame is each `FRAME` or `COMPONENT` whose parent is a `--node` or a `SECTION` under it; `width` and `height` are rounded up. Writes `{file, source, frames:[{node, name, page, width, height}]}` (a frame reached from two nodes is listed once; `page` is the name of the `--node` it was found under) and prints the count. This file is the design inventory `ui-coverage` checks the matrix against. Exit 2 without a token or on an API error; the token is never printed. No token: write the same shape by hand from the Figma MCP `get_metadata`. |
| `compare` | `--url U --root SEL --cache DIR [--map map.json] [--steps steps.json] [--bypass-csp] [--no-autofocus] [--max-diff 0.5] [context flags] [--out DIR]` | Viewport = frame size, DSF = scale. Element gate (box +-1px, font, line-height, letter-spacing, colour, background, radius, padding, gap) then pixel gate (odiff, threshold 0.1, anti-aliasing ignored; size mismatch is reported first and both images are padded). |
| `responsive` | `--url U [--widths 320,...,1920] [--height 900] [--steps steps.json] [--bypass-csp] [--no-autofocus] [--same-in-all-locales "ICE,Google"] [context flags] [--out DIR]` | Per width, the findings in the table below. Screenshots `w<width>.png` stay on disk. |
| `batch` | `--states file.json [--only surface[,surface]] [--jobs 4] [--resume] [--out DIR]` | Many states in one run (below). `compare` for a state with `figma`, `responsive` for a state with widths. |
| `columns` | `--url U --table SEL [--width 1440] [--no-autofocus]` | Body cells vs header cells: left delta <= 1px, width delta <= 2px. |

Output (`--out`, default `<cache>/runs/<timestamp>` for compare, the OS temp dir otherwise): `report.json`,
`report.md` (<= 40 lines), `actual.png`, `diff.png` (absent on an exact match).

`map.json` maps Figma node ids from `spec.json` to CSS selectors: `{"1:2": "[data-testid=title]"}`.

## `responsive` findings and hints

Findings fail the run (exit 1). Each is decided by a pure function on plain element facts (`lib/rendered-checks.mjs`, `lib/bidi.mjs`) and capped at 50 per check and width.

| Finding | Fails when |
| ------- | ---------- |
| `hscroll` | the page is wider than the viewport |
| `offscreen` | a visible element lies outside `0..viewport` (not fixed, not clipped by an ancestor) |
| `clipped-text` | an element's text is wider than its box and the box does not use `text-overflow: ellipsis` |
| `small-text` | text under 12px at viewports narrower than 768 |
| `tap-target` | a visible link, button, input, select, textarea or `role=button/link/tab/menuitem/checkbox/switch/radio` whose computed `display` is not `inline` is under 24x24 CSS px (WCAG 2.5.8); inline elements are skipped, as before |
| `bidi-field` | a left-to-right field (tel, email, url, number ...) in an rtl context that really holds a value and computes `direction: rtl` (details below; an empty field is only the hint `bidi-field?`) |
| `bidi-placeholder` | an rtl context, a visible empty field whose placeholder has a strong right-to-left letter (Persian, Arabic, Hebrew) and renders left to right (details below) |

### Hints

A new heuristic ships as a hint until it has proven itself. Hints are listed in their own "Hints" section of `report.md` (at most 12 lines) and in `hints` of `report.json`, never change the verdict or the exit code, and a `batch` record carries their count in `hints` (the other record fields are unchanged); `summary.md` has a `hints` column and a "Hints" section that lists them per state and width. Each one is to be confirmed (hand-set the matrix cell to fail with a reason) or dismissed with a reason.

| Hint | Listed when |
| ---- | ----------- |
| `target-size?` | an inline link or button under 24x24 that is NOT inside running text (nav, breadcrumb, pagination, footer, language links). WCAG 2.5.8 exempts inline targets in a sentence or text block only; the check looks at letters or digits beside the link in its block, through inline wrappers such as `strong`, `em` or an inline `li`. Separators like `\|` do not count as text. The WCAG spacing exception is not implemented |
| `raw-i18n-key` | a visible text node whose whole trimmed text matches `/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/` (a lookup that printed its key, e.g. `reset.hint`). Skipped: text in `code`, `pre`, `kbd`, `samp`, `select`; hidden or collapsed content (closed `details`, a zero-height accordion, an opacity 0 wrapper); versions (`v1.2.3`); a last segment that is a file extension (`package.json`, `node.js`, `report.final.pdf`) or a public-suffix-like TLD (`example.com`, `acme.io`); a digit-only segment (`fig.1`); single-letter abbreviations (`i.e`); anything with an uppercase letter. A real key that ends like a file or host name (`help.app`) is missed |
| `focus-indicator` | the page is walked with the real Tab key (so `:focus-visible` applies): up to 60 focusables (and 120 presses), through open shadow roots, stepping over iframes (their content is not inspected). It is listed when nothing differs between the unfocused and focused computed style of: the element or its `::before`/`::after` (outline, box-shadow, border, background colour or image, text decoration, transform, generated content), 3 ancestors (focus-within, `:has`), the label, the next 8 siblings and the previous one, the element's first 8 descendants, or the content of an open shadow root (these also count a width/height change, e.g. a growing underline). An outline or border colour counts only when the line is drawn, because both follow the text colour; a change of the text colour alone does not count. A visually hidden control (opacity 0, clipped, 1px: a custom checkbox's real input) is judged on those related elements only, its own invisible outline does not count. Runs last, because focus handlers can change the page |
| `bidi-placeholder?` | the placeholder is rtl (so `bidi-placeholder` does not fire) but the field aligns it with a physical `text-align: left` (computed on `::placeholder`). Use `start`, and apply `left` only while the field holds a value |
| `ltr-run-in-rtl?` | a visible text node in an element that computes rtl holds a phone number with no isolation: the element or an inline ancestor up to the first block is not a `bdi`, `dir="ltr"` or `unicode-bidi: isolate\|plaintext\|embed`. A phone number is `+` and 7+ digits/separators (`+98 912 345 6789`), or 9+ digits in groups separated by spaces or brackets (`0912 345 6789`): the groups swap places. An email address or a URL (`http(s)://`, `www.`) is listed only when it starts or ends with a digit or a symbol (a trailing `/`); letters at both ends keep their order without isolation, so `support@example.com` is not listed, and a full stop after a URL belongs to the sentence. Block elements never count (the browser style gives `p`, `div` and every `[dir]` element `unicode-bidi: isolate`, which only separates paragraphs). Wrap the run in `<bdi dir="ltr">`. Skipped: `code`, `pre`, `kbd`, `samp`, hidden text, ltr elements |
| `untranslated?` | ONE row per page and width: the count and the first 5 different texts (40 characters each). A text is listed when its containing element computes rtl and every letter in it is Latin, with a word of 3+ letters (`Sign in`, `Submit`). What is read: text nodes, option labels (also of a closed `select`, they are in the DOM), the shown `placeholder`, `aria-label`, `title`, `alt` and the `value` of a submit/button input. Skipped: an element or ancestor whose `lang` differs from the document's (`<span lang="en">`), `translate="no"`, `dir="ltr"`, `code`, `pre`, `kbd`, `samp`, `bdi`, textarea content, hidden text, an ltr context, emails and URLs inside the text, a text that is only a number, an acronym of up to 5 capitals (`PDF`) or a brand-shaped word (`iOS`, `YouTube`), and the terms of `--same-in-all-locales "ICE,Google Pay"` (states file: `sameInAllLocales`): whole words or whole phrases in any letter case, never part of a word. A sentence in the page's script with a Latin brand in it is never listed |
| `same-as-default?` | `batch` only: the same surface and state at the same width in several locales; one row per record (count and the first 5 texts): texts of 2+ words that are identical in the FIRST locale (the first record of the surface and state that has a texts file; if it errored, the next one is the base) and in another one, so the other locale probably shows the default text. Works for ltr locales too (en and de). Same allow-list as `untranslated?` (the compared state's). Each responsive run of a batch saves its comparable texts (a list of strings) next to its report as `texts-w<width>.json`; after the last state the later locales are compared, and the hints are written into their `report.json`, `report.md`, `hints` count and `summary.md`. `results.json` carries only the count. A second pass (`--resume`) replaces the hints, it does not add them again |
| `rtl-physical-align` | a visible text block (non-inline element with its own text) whose own direction is rtl and whose computed `text-align` is `left` (or `-webkit-left`). In rtl the default computes `start`, so `left` only appears when it was written; use `start`. Skipped: `pre`, `code`, `kbd`, `samp`, `textarea`, `button`, table cells holding only numbers, `dir=auto` text, blocks that are themselves ltr |

### Target size

The proof run did not report 21x18 px language links. Cause: the `tap-target` check skips every element whose computed `display` is `inline`, a stand-in for the WCAG 2.5.8 exemption for targets inside a sentence or text block that is wider than the rule (a row of inline links in a `<nav>` is not text). The failing check is left as it was; the links the exemption over-covers are now `target-size?` hints (above).

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

  `focus` fails the step when the element is not `document.activeElement` afterwards (a `div` without `tabindex`, a disabled control). A pointer step (`click`, `check`, `uncheck`, `hover`) that times out adds what is drawn at the target's centre (`elementFromPoint`: tag, id, class) and, for a visually hidden input, the hint to click its label instead.

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

Direction of form fields in an rtl context (the computed direction of the element that holds the field or text, not of `<html>`: a `<body dir=rtl>` or an rtl section is judged, an ltr island inside an rtl page is not): only the typed VALUE of a phone, email, URL, code, number or card field is left to right. The placeholder, label, hint, error and the order of adornments are translated text and follow the page direction and alignment. Both states, empty and filled, are checked.

Finding `bidi-field` (`responsive`): in an rtl context, a visible `input`/`textarea` whose `type` is `tel`/`email`/`url`/`number`, or `inputmode` is `numeric`/`decimal`/`tel`/`email`/`url`, or `autocomplete` contains `tel`/`email`/`url`/`one-time-code`/`cc-number`/`postal-code`, that holds a value and whose computed `direction` is rtl. It fails the run only for a value that really sits in the field (typed by a `--steps` fill, or the `value` attribute). An EMPTY field is probed instead: the tool sets the value `1` from the page script, reads the computed direction, and puts the field back (the native `value` setter, so no input or change event and no framework setter runs; the field stays empty, its selection stays 0,0 and focus does not move; the `selectionchange` the browser queues is swallowed for 100 ms). Only text-like types are probed (text, search, tel, url, email, password, number, textarea: a fixed allow-list; date, file, range, color, checkbox and the rest are never touched). Because the probe fires no events, a page that sets the direction from an `input` listener would be failed wrongly, so an rtl probe result is only the hint `bidi-field?` ("could not confirm from an empty field: run a state that types a value"); the `filled` state of the ui-coverage matrix, run in every RTL locale, is the strict check. A probe that computes ltr is a pass. The fix: make only the typed value left to right, e.g. `input:not(:placeholder-shown) { direction: ltr }` (it needs a `placeholder` attribute; without one the rule always matches), or `dir="ltr"` on the field when it has NO translated placeholder. Chromium's built-in style makes a bare `type=tel` input ltr also while empty, so its Persian placeholder is then reported by `bidi-placeholder`: add `input:placeholder-shown { direction: inherit }`. One finding per field per width.

Finding `bidi-placeholder` (`responsive`): an rtl document, a visible field that is empty (`:placeholder-shown`), a placeholder with at least one strong right-to-left letter, and the placeholder renders left to right: the computed `direction` of `::placeholder` (Chromium reports it, and it always equals the field's own direction: a `direction` rule on `::placeholder` is ignored). `dir="ltr"` on the field does exactly this. A placeholder with no right-to-left letter (digits, `0912 345 6789`, an example email) never fires, and digits are not strong letters in any script. Fields inside open shadow roots are judged; `contenteditable` elements are not (they are not inputs, and have no placeholder attribute).

Hint `bidi-field?` (`responsive`): the empty-field probe above, or the same context and a field direction (while it holds a value) where the field has no type/inputmode/autocomplete hint, is a plain text field (`type=text` or none, or a textarea), and its `name`, `id`, `autocomplete` or `aria-label` matches `/phone|mobile|tel|otp|code|email|url|iban|card/i`. It is listed in the report and in `findings`, but never fails the run (verdict and exit code ignore it).

## `batch`

`ui-check batch --states states.json [--out DIR] [--only surface[,surface]] [--jobs N] [--resume]` measures many states in ONE run: one browser, a fresh context per state, `--jobs N` states at a time (default 4), and a failing state never stops the run. The file is validated before anything launches; an error names the state index and field (`states[2].locale: ...`), and unknown fields are rejected.

```json
{
  "defaults": { "baseUrl": "http://localhost:3000", "locale": "en", "colorScheme": "light", "widths": [320, 1024],
                "storage": { "lang": "en" }, "cookies": {} },
  "states": [
    { "surface": "login", "state": "language:open", "locale": "fa", "url": "/login", "expectDir": "rtl",
      "storage": { "lang": "fa" }, "steps": [{ "action": "click", "selector": "#language-menu" }, { "action": "waitFor", "selector": "#language-list" }] },
    { "surface": "home", "state": "rest", "locale": "en", "url": "/", "widths": [390],
      "figma": { "file": "FILEKEY", "node": "1:2", "map": "home-map.json", "root": "#home" } }
  ]
}
```

Names: `surface`, `state` and `locale` are copied into the records as written, and `ui-coverage check` matches them against its matrix, so use its names: `state` is `rest` or `<control>:<state>` (run `ui-coverage states` for the list), `surface` is the matrix surface id, `locale` is a matrix locale tag, letter case aside (tag `fa` needs `fa`, and `fa-IR` does not match it; this tool records the tag in canonical case, so `FA` and `fa` both arrive as `fa`). Do not write the file by hand: `ui-coverage scaffold matrix.json --out states.json` writes one entry per open matrix cell with those names, and you fill `url`, `steps` and `defaults`.

- `defaults` (all optional): `baseUrl` (a state `url` is resolved against it), `locale`, `colorScheme`, `widths`, `storage`, `cookies` (objects of string values), `sameInAllLocales` (array of terms that are the same in every language, for `untranslated?` and `same-as-default?`). A state's own `locale`, `widths`, `sameInAllLocales` replace the default; its `storage`/`cookies` are merged by key over the default's.
- State: `surface`, `state`, `url` required. `steps` is an array (same actions as `--steps`) or a path to a steps file, relative to the states file. `figma` is `{file, node}` (the cache `figma-pull` filled), plus optional `map` (path relative to the states file) and `root` (selector, default `body`; the compare screenshot and size gate use it). A state needs `figma` or widths. `surface` + `state` + `locale` must be unique.
- `compare` runs for a state with `figma` (tolerances as the `compare` command, `--max-diff` default), `responsive` for a state with widths (default widths apply to every state, figma or not); both run when both are present. `--only` keeps the listed surfaces; a list that mixes known and unknown surfaces exits 2 naming the unknown one.
- A state that throws (bad step, HTTP error, `expectDir` mismatch, missing Figma cache) becomes failing records with the error as the finding, and the run goes on.
- A hint finding (`bidi-field?`) keeps a record `pass`; so does every other hint (`same-as-default?` included, see above).
- Zero states to run (empty `states` array, or `--only` matching no surface) prints why on stderr, writes `results.json` as `[]` and a FAIL `summary.md`, and exits `1`.
- `results.json` and `summary.md` of an earlier run in the same `--out` are deleted at the start, so a failed or empty run never leaves stale passes.
- `--jobs N` (default 4, a whole number >= 1): states WITHOUT a `figma` part run N at a time in separate contexts of the one browser. States with a `figma` part always run one at a time after all the others (pixel captures are load-sensitive). `--jobs 1` is the old sequential order. `results.json` keeps the states-file order whatever finishes first.
- Progress: one line per finished state on stderr, `[12/201] signup role:open fa 320 fail 1.4s` (finished count, surface, state, locale or `-`, widths of its records, `pass` or `fail`, seconds). stdout still holds only the final `PASS|FAIL batch ...` line.
- `--resume`: keep the `results.json` already in `--out` and skip the states whose records ALL pass and cover every width of the state (a state that gained a `figma` part needs a compare record too); failing, missing or changed-width states re-run. The new `results.json` holds the selected states only (a record of a state not in this run, e.g. with `--only`, is dropped). While a run is going `results.partial.json` holds the finished states (it is deleted when `results.json` is written), so a killed run can be resumed: `--resume` reads both. Without `--resume` the old `results.json`, `summary.md` and `results.partial.json` are deleted at the start, as before.
- Exit `1` when any record fails or none ran, `2` for a bad flag or states file, else `0`.

Output in `--out` (default under the OS temp dir): `results.json`, `summary.md` (one table row per state x width), and per state a folder `<index>-<surface>--<state>--<locale>/{compare,responsive}/` with the usual `report.*` and screenshots. The state folder always exists; when a part throws, its stack is in `<part>.error.txt` there (also a context that fails to close, which turns that part's records into failures). `results.json` is an array of records read by `ui-coverage check --results`; the field names are a contract:

```json
{ "surface": "login", "state": "language:open", "locale": "fa", "width": 320, "status": "fail",
  "evidence": "/tmp/ui-check/batch/<run>/0-login--language-open--fa/responsive/report.md",
  "findings": [{ "check": "bidi-field", "element": "input#otp", "detail": "..." }], "hints": 0, "part": "responsive" }
```

`part` is `compare` or `responsive`: the part of the state that made the record (an error record carries the part that threw). `ui-coverage` counts only `part: "compare"` records as the Figma compare of a frame; a record without `part` (an older run) counts as not-compare. A `pixel` finding also carries `percent`, the share of differing pixels as a number (`{"check":"pixel","element":"#card","detail":"...","percent":0.42}`); a size mismatch has no `percent`, because it is not a small difference that a maximum could accept.

`width` is the viewport width the part ran at: the audited width for a `responsive` record, and for the compare record the Figma frame width (`ceil(meta.width)` of the cache, an integer), so the matrix `widths` must contain the frame width. It is `null` only on an error record whose Figma cache could not be read. `locale` is `null` when none was set. `evidence` is the state's report, or the state folder when the state threw before a report existed.

## Changes in v2 (what differs from before, with the flags absent)

- `bidi-field` is judged on the filled state: an empty field that follows the page direction passes, an empty field that computes rtl is only a hint (`bidi-field?`), the direction context is the containing element, and the advice is no longer "set `dir=ltr` on the field" (that also turns a translated placeholder left to right, which `bidi-placeholder` now fails). New: `bidi-placeholder`, `--same-in-all-locales`, `sameInAllLocales`.
- Playwright is looked up in `--project` (default: the current directory), then `UI_CHECK_PROJECT`, then the tool's own `node_modules`; a project without Playwright no longer exits 2 when a later place has it.
- `batch` runs 4 states at a time by default (was one); pass `--jobs 1` for the old order of work. It prints a progress line per state on stderr and writes `results.partial.json` while running.
- `focus` steps fail on an element that did not take focus (before: silent pass). Timed-out pointer steps say what covers the target.
- `responsive` lists the hints `target-size?`, `raw-i18n-key`, `focus-indicator`, `rtl-physical-align`, `bidi-placeholder?`, `ltr-run-in-rtl?` and `untranslated?` (and `same-as-default?` in `batch`) in a separate section; they never change the verdict or the exit code. `report.json` gains `hints`, a `batch` record gains `hints` (a count), `summary.md` gains a column and a section.

## Not covered (open)

Mirroring of directional icons in rtl, a child drawn outside its parent's box, and axe-core are not part of this tool. Closed shadow roots and iframes are not entered. `contenteditable` text boxes are not judged for direction. Text in placeholders, `aria-label` and `title` is not read for `untranslated?`. An empty field that is probed gets the browser's "dirty value" flag, so a later change of its `value` ATTRIBUTE from page script no longer shows in it (a reload resets it).

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
`rendered-browser.test.mjs` (the four hints on local and reviewer fixtures, focus and click step errors), `ltr-values-browser.test.mjs` (empty and filled fields, `bidi-placeholder`, the probe, the text hints, `same-as-default?` in `batch`), `batch-parallel.test.mjs` (`--jobs 4` equals `--jobs 1`, `--resume`) and
`locale-browser.test.mjs` (bidi-field, `--expect-dir`, storage, locale, cookie, `batch`; it briefly writes a fixture Figma cache under `~/.cache/figma/ui-check-batch-test-<pid>` and removes it).

## Layout

`cli.mjs` dispatch; `commands/*` one file per command (`batch` reuses `compare` and `responsive`); `lib/*` small modules (spec flattening, cache, Figma
REST, browser setup, in-page measure/audit, element comparison, pixel gate, report).
