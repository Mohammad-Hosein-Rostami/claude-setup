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
| `figma-pull --bulk` | `--bulk --file KEY --node PAGE_OR_SECTION [--scale 1] [--refresh]` | Every frame and component-set variant under the node, one nodes call and one images call, same cache layout (section "Figma bulk, refresh and export" below). |
| `figma-pull --from-export` | `--from-export DIR --file KEY [--scale 1] [--refresh]` | Cache folders from a local export folder, no network, no token: a nodes.json folder, or Figma's own PNG export (formats below). |
| `figma-refresh` | `--file KEY --node ID [--scale 1]` | Re-fetches into a temp folder and prints `changed` / `unchanged` / `new` / `gone` per frame; never writes the cache. Exit 0 all unchanged, 1 otherwise. |
| `figma-frames` | `--file KEY --node ID [--node ID]... --out frames.json` | Needs env `FIGMA_TOKEN`. One REST call per `--node` (nodes endpoint, depth 2); a node id in the URL form `12-40` is sent as `12:40`. A frame is each `FRAME` or `COMPONENT` whose parent is a `--node` or a `SECTION` under it; `width` and `height` are rounded up. Writes `{file, source, frames:[{node, name, page, width, height}]}` (a frame reached from two nodes is listed once; `page` is the name of the `--node` it was found under) and prints the count. This file is the design inventory `ui-coverage` checks the matrix against. Exit 2 without a token or on an API error; the token is never printed. No token: write the same shape by hand from the Figma MCP `get_metadata`. |
| `compare` | `--url U --root SEL --cache DIR [--map map.json] [--steps steps.json] [--bypass-csp] [--no-autofocus] [--max-diff 0.5] [--strict] [context flags] [--out DIR]` | Viewport = frame size, DSF = scale. Element gate (box +-1px, font size and family, the font actually drawn (section "Drawn font" below), line-height, letter-spacing, colour, background, radius, padding, gap, stroke width and colour by `strokeAlign` (INSIDE = border, OUTSIDE = outline or box-shadow ring, CENTER = outline with offset -weight/2; standards/figma.md), image fills loaded and of the right aspect, and every broken eager image in the root even without a map) then pixel gate (odiff, threshold 0.1, anti-aliasing ignored; size mismatch is reported first and both images are padded) plus the colour metric (any channel > 2 levels, anti-aliasing counted; Figma TEXT boxes left out in a default run), which fails above the same limit: odiff's threshold hides a uniform drift of up to about 26 levels. `--strict` = the strict rule: `--max-diff 0` and the colour metric over every pixel (fail closed until `attribute` classes text anti-aliasing). |
| `responsive` | `--url U [--widths 320,...,1920] [--height 900] [--steps steps.json] [--bypass-csp] [--no-autofocus] [--same-in-all-locales "ICE,Google"] [context flags] [--out DIR]` | Per width, the findings in the table below. Screenshots `w<width>.png` stay on disk. |
| `batch` | `--states file.json [--only surface[,surface]] [--jobs 4] [--resume] [--prev RUN] [--out DIR]` | Many states in one run (below). `compare` for a state with `figma`, `responsive` for a state with widths. Writes `ledger.json` beside `results.json`; `--prev RUN` prints the round table (see `run`). |
| `run` | `--matrix M [--strict] [--base-url U] [--states S] [--out DIR] [--jobs N] [--only surface,...] [--prev RUN] [--no-worse RUN] [--same RUN] [--self-test] [--step <plan>.s<N>]` | The one call of a UI round (section `run` below): `ui-coverage scaffold` + `batch` + `ui-coverage check`. |
| `columns` | `--url U --table SEL [--width 1440] [--no-autofocus]` | Body cells vs header cells: left delta <= 1px, width delta <= 2px. |
| `first-paint` | `--states S [--only surface[,surface]] [--out DIR] [--project DIR]` | Per state, cold-loads the URL with every script held, then every font held, and checks the frames in order: blank and/or one neutral loader, then the final screen, nothing in between, no layout shift after the first visible frame (section `first-paint` below). |
| `figma-diff` | `--states S [--only surface[,surface]] [--decisions D] [--out DIR] [--project DIR]` | Per state with a `figma` part: built parts and texts with no Figma node, Figma texts and drawings with no built part, wording differences; each row classed `fix`, `keep` or `ask the owner` (section `figma-diff` below). |
| `attribute` | `--results DIR [--accepted matrix.json] [--strict]` | Per compare record of `DIR/results.json`, every leftover colour-metric pixel goes to the topmost Figma node and a class: accepted, text anti-aliasing, flagged text, graphic, other; one row per class per state, crops baseline \| actual \| diff per cluster (section `attribute` below). |

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
- `responsive` lists the hints `target-size?`, `raw-i18n-key`, `focus-indicator`, `focus-ring-width`, `rtl-physical-align`, `bidi-placeholder?`, `ltr-run-in-rtl?` and `untranslated?` (and `same-as-default?` in `batch`) in a separate section; they never change the verdict or the exit code. `report.json` gains `hints`, a `batch` record gains `hints` (a count), `summary.md` gains a column and a section.

## Drawn font (`compare`, and `batch` through it)

The `font-family` row compares the first family of the computed `font-family` with Figma's. That alone passes a page that asks
for Inter but never loads it: the browser then draws a fallback (Helvetica on macOS). So for every mapped Figma TEXT node with a
font family, `compare` also reads the fonts Chromium actually drew for every glyph of the element, with the CDP call
`CSS.getPlatformFontsForNode` (`lib/drawn-fonts.mjs`), and the element gate (`lib/elements.mjs`, pure) judges them. That call looks
only two layout levels below the node it is given, so each text node below the element is read on its own and the counts are summed:
text at any depth (`h1 > a > span`, `button > span > span`), in open shadow roots, in a field (its value or placeholder) and in
generated content (`::before`, `::after`, list markers). Frames are not entered. Reading 300 elements takes about 160 ms (MacBook,
Chromium 151).

- the family that drew the most glyphs must be Figma's, at any weight or style (case aside; a tie with Figma's family passes);
  otherwise a failing `font-family (drawn)` row, e.g. `is: Helvetica (5 glyphs)`, `should: Inter`, `delta: requested Inter, drawn
  Helvetica`;
- a fallback for fewer glyphs than Figma's family drew (a script or emoji the font lacks) passes;
- a drawn font that could not be read (no CDP session, an element not found, a CDP error), or text of which no glyph was drawn
  (all of it hidden), is a failing row `not checked (<why>)`, never a pass; an element with no text at all (an empty field, an
  image without alt text) has no row.

CDP reports a web font's family as its file names it (name ID 1). A static file other than Regular or Bold puts the face in that
name (`Poppins SemiBold`; the typographic family, name ID 16, is `Poppins`), and a variable file may say `Inter Variable`. CDP gives
no name ID 16, so the face words are taken off the end of the drawn name before it is compared: Thin, ExtraLight, UltraLight,
Light, Regular, Normal, Medium, SemiBold, DemiBold, Bold, ExtraBold, UltraBold, Black, Heavy, Italic, Oblique, Variable and VF, in
any combination, case, spacing or hyphens (`Inter Semi Bold Italic`, `Inter-ExtraBold`). Any other word after Figma's name names
another family and still fails (`Inter Tight`, `Inter Display`, `Roboto Condensed`, `Exo 2`); a family whose own name ends in a
face word, drawn where Figma asks for the name without it (`Archivo Black` for `Archivo`), passes.

The Font Loading API is not used as a fallback: probed with Playwright 1.62.1 (Chromium 151, macOS), `document.fonts.check()`
answered `true` for "Roboto", which was neither installed nor loaded while CDP reported Helvetica, so it cannot tell a fallback
from the real font. ui-check launches Chromium only; an engine without a CDP session would get `not checked` on every drawn-font row.
The check judges the machine it runs on: when a page's web font fails to load but the same family is installed locally,
Chromium draws the installed one (probed: a failing `@font-face` named Helvetica still drew Helvetica), so the row passes there.

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
browser smoke test (fixture compare pass/fail, the card title drawn in its Inter web font and, with `?font=absent` (a family no machine has), a fallback that fails the drawn-font row, a static SemiBold face that passes it, text deep below the mapped element counted glyph for glyph, and a 500px box at 320), the Chromium checks in `determinism.test.mjs`, and
`rendered-browser.test.mjs` (the four hints on local and reviewer fixtures, focus and click step errors), `ltr-values-browser.test.mjs` (empty and filled fields, `bidi-placeholder`, the probe, the text hints, `same-as-default?` in `batch`), `batch-parallel.test.mjs` (`--jobs 4` equals `--jobs 1`, `--resume`) and
`locale-browser.test.mjs` (bidi-field, `--expect-dir`, storage, locale, cookie, `batch`; it briefly writes a fixture Figma cache under `~/.cache/figma/ui-check-batch-test-<pid>` and removes it).

## Layout

`cli.mjs` dispatch; `commands/*` one file per command (`batch` reuses `compare` and `responsive`); `lib/*` small modules (spec flattening, cache, Figma
REST, browser setup, in-page measure/audit, element comparison, pixel gate, report).

## `run` (one call per UI round)

`ui-check run --matrix matrix.json --base-url http://localhost:5173` does, in one call:
1. `ui-coverage scaffold` into the states file (`--states`, default `states.json` beside the matrix): missing entries are added, existing ones kept. `--base-url` is written into its `defaults.baseUrl`. An open entry whose `url` is still empty exits 2 naming it (fill `url` and `steps` once; later rounds reuse the file).
2. `batch` on that file (`--jobs`, `--only`, `--project` as for `batch`), into `--out` (default a new folder under the OS temp dir).
3. `ui-coverage check matrix --results <out>/results.json`, whose report is printed.

Output: the counts, then per failing record its first 5 findings and, for a pixel failure, the crop paths of the diff region:
`crop-<n>.png` beside `actual.png`, at native scale (1:1 device pixels, never resized) and at most 2,576 px on the long edge (a larger
region is cut into several crops), because a bigger image reaches the model shrunk and loses 1-px detail. No image path is printed
for a passing state. A crop explains a failing row; PASS and FAIL are the numbers. Last line: `result: PASS|FAIL run - ...`.
Exit 0 only when every record passes, the matrix check passes, `--no-worse` finds nothing worse and `--self-test` is clean.

Round ledger (`lib/ledger.mjs`, also written by `batch`): `<out>/ledger.json` holds the comparator (name, version, options: today
odiff, threshold 0.1, anti-aliasing ignored), the renderer (platform, Chromium version), the `--step` label, the commit sha of HEAD,
and per compare state (diagnostic states excluded) the sha256 of the capture, the leftover pixels, the failing element rows and the
pixel ratio. Every compare record in `results.json` carries `url`, `images` {baseline, actual, diff}, `scale`, `diffPixels` and `comparator`.
The ledger also holds `root` (the absolute git top-level of the folder `run` started in, so `cd <worktree> && ui-check run ...` names
that worktree; null outside git) and `captures`: per responsive record (state x width, diagnostic states excluded) its key
`surface / state / locale @width`, `file` (the `w<width>.png` screenshot, relative to the run folder), `sha256` (null when the file is
missing or unreadable), `findings` (finding ids `check element`, hints left out) and `pageErrors` (the page's uncaught errors,
Playwright `pageerror`: throws and unhandled rejections, not `console.error`; at most 50, 300 characters each). Every responsive record
in `results.json` with a screenshot carries `capture` and `pageErrors`; page errors never change a verdict. Older ledgers without
these fields read as before.
- `--prev RUN` (the previous round's `--out` folder or its `ledger.json`): per state `identical` (same sha256 and counts), `gain`, `no-gain` (a failing state
  whose pixels and rows did not go down) or `new`, with the change in pixels and rows; `PLATEAU` after 2 no-gain rounds in a row:
  change approach (figma-pixel-perfect step 5), never lower the bar.
- `--no-worse RUN`: against the lane's reference run (a `run` on the base tip at lane start), per state `identical` (same sha256 and counts: a
  matching hash with other counts is judged on the counts), `equal` (same
  counts, other bytes), `better`, `worse`, `new` (INFO: no reference row) or `missing`; any `worse`, `missing` or a different pixel
  ratio fails (exit 1). Always against the reference, never the previous round, so a state worse in round 2 and unchanged in round 3
  still fails. A reference made with another comparator (name, version or options) or renderer prints the `different comparator` /
  `different renderer` line and exits 1: take a new reference on the base tip, never on the lane tip (diff counts do not carry
  between comparators).
- `--same RUN` (a base run's `--out` folder or its `ledger.json`, read once before anything runs; unreadable exits 2 naming `--same`):
  is each responsive capture the same render as the base run's (a run of the same matrix and states on the base tip)? Exits 2 before
  anything runs when RUN is this run's own `--out` folder (compared by real path, so a link, `/tmp` against `/private/tmp` or, on macOS
  and Windows, other letter case is the same folder), or when the base ledger records no git head or this run's own head (commit the
  change first: a base of the same commit proves nothing). Per capture (`lib/same-run.mjs`): `identical` (same sha256), `equal` (other
  bytes, the same decoded RGBA pixels: 0 px differ, no tolerance), `changed` (any pixel differs in any channel, or the size does; the
  exact count, then odiff and the colour metric with the diff image under `<out>/same/`), `new` (no base row), `missing` (a base row
  this run lacks, or a capture on either side that does not count: absent, unreadable, a link, outside its run folder, or bytes that
  no longer hash to the sha256 its ledger recorded; never identical), `other-renderer` (the base was made with another comparator or
  renderer: every row, never compared) or `refused` (the same head check, for a caller other than `run`: every row, never compared).
  A capture counts only when its bytes, read now from a plain file inside its run's real folder, hash to its recorded sha256; the
  verdict is made from those bytes. Each row also lists `newFindings` (finding ids the base row lacks) and `newPageErrors` (page errors
  beyond the base row's, counted per message). Printed as `same: <i> identical, <e> equal, <c> changed, <n> new, <m> missing`
  (`same: 0 rows` when there is no capture), then each row that is not identical or equal or has something new; stored in the
  ledger as `same: {ref: {file, sha256, head, createdAt}, mismatch, refused, rows}`. It never changes the exit code: the check plan
  reads it. Writes only under this run's `--out`.
- `--self-test`: captures every compare state a second time (into `<out>/self-test`); a state whose two captures differ in sha256
  is a failing `nondeterministic` finding.
- Pass rule: `--strict`, or `rule: strict` in the matrix (`ui-coverage init --rule strict`), makes every compare strict (the stricter
  rule wins); every record and the ledger store `rule` and the project's viewing conditions (`ui-coverage conditions`), and a PASS
  under a looser rule than the matrix asks does not count.
- `--step <plan>.s<N>`: stored in the ledger; the baseline `run --step` on the base tip before a plan step starts is that step's
  start record (read by `ui-proof`).
- Capture-only CSP bypass for development servers: states-file `defaults.bypassCSP: true` (for `batch` and `run`). It exits 2,
  naming the host, unless every state URL is loopback (`localhost`, `*.localhost`, `127.0.0.1`, `::1`) or `file:`. The flow e2e keeps the CSP on.

## Figma bulk, refresh and export (`figma-pull --bulk`, `figma-refresh`, `figma-pull --from-export`)

What a node holds (the targets): the node itself when it is a `FRAME` or `COMPONENT`; its variants when it is a
`COMPONENT_SET`; otherwise each `FRAME` or `COMPONENT` that `figma-frames` lists (children of the node and of a `SECTION`
under it) followed by every `COMPONENT` inside a `COMPONENT_SET` in those places (the variants are the baselines for
control states: hover, focus, disabled). Hidden targets (`visible: false`) are left out, since Figma renders no image for
them. Each target gets the usual cache folder (`baseline.png`, `spec.json` from `flattenSpec` on the node's raw
document, `meta.json`); `meta.json` also holds `kind` (`frame` or `variant`), `set` (the component set's name, variants
only), `pulledFrom` (the `--node`, or the export entry) and `source` (`api` or `export`).

- `figma-pull --bulk --file KEY --node ID`: one nodes call (the whole subtree of the node) and one images call for the
  targets not yet cached (none when all are; `--refresh` fetches them all again and overwrites). A node id in the URL
  form `12-40` is sent as `12:40`. Prints one line: targets, frames, variants, pulled, already cached, hidden. One images
  call renders every target at once: a very large page can hit Figma's render timeout; pull it section by section.
- `figma-refresh --file KEY --node ID`: the same two calls for every target, written under a new temp folder
  (`<os temp>/ui-check-refresh-*/<KEY>/<ID>/`, printed at the end), then per target: `unchanged` (spec.json deep-equal
  and baseline bytes equal), `changed` (names `spec`, `baseline bytes` or both), `new` (not in the cache), and `gone` (a
  cache folder whose `meta.json` says an earlier `--bulk` of this node pulled it, no longer under the node or now hidden).
  The cache is never written; update it with `figma-pull --bulk --refresh`. A cache written before a `flattenSpec`
  change shows as `changed (spec)`; a re-render can differ in bytes without a design change (`changed (baseline bytes)`
  with the spec equal). Exit 0 when all are unchanged, 1 otherwise, 2 on an API or usage error.
- `figma-pull --from-export DIR --file KEY`: no network and no token. `DIR` holds `nodes.json`, the Figma nodes-API
  answer of the exported nodes (`{"nodes": {"12:40": {"document": {...}}}}`, the shape of
  `GET /v1/files/KEY/nodes?ids=...` without `depth`, so the whole subtree is in it), and one `<node id, ":" as "-">.png`
  per target (an entry that is a frame needs its own PNG; an entry that is a page or section needs one per target under
  it, `12-41.png`). `--scale` says what scale the PNGs were exported at (default 1). A missing PNG, a file that is not a
  PNG, or a `nodes.json` of another shape exits 2 naming the file. `--node` is refused here.
  Unconfirmed: this folder format is the setup's choice (the ICE scripts saved the nodes-API answer raw and the PNGs by
  node id). How the PC project's own gate stores its Figma results has not been read yet (the top-level keys of one of
  its result files, `round9` phase-start step); until it is, this format may change to match it.
- `figma-pull --from-export DIR --file KEY` with Figma's own export (a folder with **no** `nodes.json`; File > Export, one
  PNG per layer): the PNGs are matched by layer name to the nodes an earlier `figma-pull --bulk --file KEY --node ...`
  cached. A file is `<layer name>.png` (1x) or `<layer name>@2x.png` (the `@Nx` suffix is the scale; without it
  `--scale` applies, default 1); a `/` in a layer name is a subfolder (`Buttons/Primary.png` is the layer `Buttons/Primary`).
  Each matched cache folder keeps its `spec.json` and gets the exported `baseline.png` and a `meta.json` with that scale
  and `source: export` (it overwrites without `--refresh`). It exits 2, writing nothing, when: the folder holds no PNG, a
  PNG is empty (0 bytes) or not a PNG, the file has no cache from `--bulk` (run it first), a PNG matches no layer name, two
  cached nodes share the layer name, or two PNGs map to one layer; the message lists the names (at most 20, quoted).
  Limits: 2000 PNGs, 6 folder levels, 200 characters per path, 64 MB per PNG; links are refused. Names are only compared
  with layer names, never run or used as a write path.
  Unconfirmed (U1: Figma forum threads only, no official page): how Figma names its export files; check it on the first real export.

## `first-paint` (the loader, then the one right screen)

`ui-check first-paint --states states.json [--only surface[,surface]] [--out DIR] [--project DIR]` checks what a visitor sees
while a page loads (`async-ui-states` items 7-8). Per state it cold-loads the URL twice in a fresh context: first with every
script held back, then with every font held back (each held 1.5 s after navigation, then released), and records one frame
each time what is on screen changes, from navigation until the page has settled (no frame change for 1 s and no request in
flight for 500 ms; the network wait gives up after 5 s for long-polling apps; a page still changing after 15 s fails).

A frame is one of:

| Kind | What is on screen |
| ---- | ----------------- |
| `blank` | nothing to read or use: no visible text, form control, link, button, heading or image; only backgrounds and shapes (so a CSS or SVG spinner without a role is blank too) |
| `loader` | the neutral loader: every visible text, control or image sits inside an element with `role="progressbar"` (MUI `CircularProgress` and `LinearProgress` have it). A "Loading..." text outside such an element is a screen, so give the loader that role |
| `fallback` | fonts pass only: a screen shown while one of its font faces is still loading (fallback face or invisible text) |
| `screen` | anything else. Two screens are the same when every visible content element has the same tag, own text (and a field's value and placeholder) and box, rounded to 1 px |

A pass passes when the frames in order are `blank` and/or one `loader`, then the final screen, with nothing in between (a
second screen, a fallback-font frame, a blank frame after a loader or a screen, a second loader) and no layout shift (the
browser's layout-shift entries) from the first frame that is not blank. The loader definition is cut from the ICE harness,
where "empty" was the background only; `role="progressbar"` adds the one loader `async-ui-states` item 7 allows.

- Used from the states file: `url` (http or https only, because files are held through Playwright's request router), the
  locale, colour scheme, storage, cookies and `expectDir` (checked after the page settles). Viewport: the Figma frame size
  for a state with `figma`, else its first width x 900. `steps` are not run: first paint is the cold load, steps come
  after it; the output says `(steps not run)`. States with the same URL, viewport and context are measured once.
- Nothing is injected into the page but a read-only sampler: no freeze or transition-off style, and reduced motion is not
  requested, because transitions and late swaps are what this check looks for. On MUI do not use the capture preset for it.
- Output: one stdout line per state (`PASS|FAIL|ERROR surface state locale - scripts: <screens or reason> | fonts: ...`)
  and a final `PASS|FAIL first-paint` line; in `--out` (default under the OS temp dir) `report.md`, `report.json` and per
  state `<index>-<surface>--<state>--<locale>/<hold>.json` with the held files, the frame records and the layout shifts.
- Exit `0` every pass of every state passes, `1` a pass fails or nothing matched `--only`, `2` a bad flag or states file,
  or a state that could not be measured (HTTP error, missing Figma cache, a file: URL) while none failed.
- Not covered: two different loaders shown one after the other look the same (both are `loader`); a skeleton screen with
  no text counts as `blank`; text inside shadow roots (open or closed) and iframes is not read.

## `figma-diff` (what the map does not cover)

`ui-check figma-diff --states states.json [--only surface,...] [--decisions decisions.json] [--out DIR] [--project DIR]` opens every
state that has a `figma` part (same states file, viewport, steps and context as `batch`) and compares what the page shows inside the
state's `figma.root` with the cached frame (`spec.json`). The pixel gate and the element gate check only mapped nodes; this lists
what nobody mapped. Rows:

- `extra`: a built text, link, button, label, field text (typed value or placeholder; never a password) or graphic (img, outermost
  svg, canvas, video, CSS background or mask image) with no Figma counterpart.
- `missing`: a Figma text or drawing (VECTOR, BOOLEAN_OPERATION, STAR, POLYGON layers merged per icon) with no built counterpart.
- `wording`: a pair with different text, with the kind: `case`, `punctuation` (also spacing), `spelling` (at most 2 letters) or `words`.

Pairing (texts), strongest first: same wording (letters and digits, case ignored) at the nearest place; a long text (> 40 characters)
at least 80% alike wherever it moved; one text holding the other in the same place; else the same place, the most alike text. Same
place: the boxes overlap or their centres are at most 16 px apart (frame px; boxes are relative to the frame and the root). A built
line split by a link inside it is also judged as its whole block. Graphics pair by place only. Never a row: hidden Figma layers
(`spec.json` leaves them out), layers whose centre is outside the frame, a phone frame's drawn status bar or home indicator, sample
data (e-mail addresses, phone-like numbers), texts with no letter or digit (icon fonts, bullets of a masked password), drawings under
12 px, thinner than 3 px (rules, separators) or at least half the frame's width or height (background decoration).

Classes (default rule, from the ICE `figma-diff` decisions: a difference no decision covers is never passed unseen; and the setup's
standing rule: an element not in Figma defaults to "match Figma"): `missing` and `extra` are `fix` (match Figma); a `case` or
`punctuation` wording is `fix` (use Figma's exact text); a `spelling` or `words` wording is `ask the owner` (copy is a product decision,
and either side may hold the typo). `--decisions` overrides the default for matching rows; each entry needs the owner reference:

```json
[{ "type": "extra", "build": "Continue registration on another device", "surface": "register", "class": "keep",
   "owner": "STATUS.md decision 2026-11-14 B15", "reason": "the only entry to the e-mailed link flow" }]
```

An entry matches on `type` and on each of `figma`, `build` (whitespace-normalised, exact) and `surface` it gives (at least `figma` or
`build`); `class` is `fix`, `keep` or `ask`. Output: `report.md` / `report.json` in `--out` (default under the OS temp dir; the JSON has
every row with boxes, node id, selector and reason per state) and one stdout line per row, then `PASS|FAIL figma-diff - ...`. Exit 0 when
no row is open (none, or only `keep`), 1 when any `fix` or `ask the owner` row exists, 2 for a usage or setup error, also when a state
could not be compared (missing cache, HTTP error, root not found; the other states still run and the error is in the report).
`spec.json` keeps the full Figma text (until this change it cut every text at 80 characters): a cache written before that is flagged
by a warning line (Figma texts of exactly 80 characters); re-pull it with `figma-pull --refresh`.

## Map skips, diagnostic states, render bounds and the focus gate (r9-ui-states)

- Map skip entries: a `map.json` value may be `{"selector": "...", "skip": ["padding"|"gap"|"width"], "why": "<15+ characters>"}`.
  Only padding, gap and hug width can be skipped, never colour, font, x or y; another property or a missing `why` exits 2. A skip
  removes a false positive the Figma data creates (an INSTANCE node reports 0 padding); the element's box, colour and font rows still
  run, and each skipped row shows as `SKIPPED: <why>`. A `width` skip is honoured only under the strict rule; in a default run the row
  stays, with its `why` beside it.
- Diagnostic states (states file): `"diagnostic": true, "proves": {"surface": "...", "state": "..."}` (the gate state it proves; a
  `proves` that names no gate state exits 2). They stay out of the verdict and exit code, print in their own table of `summary.md`,
  carry `diagnostic: true` in `results.json`, never fill a `ui-coverage` cell and never enter the ledger or a proof reference. Only a
  diagnostic state may use the steps `hide` / `remove` / `replace` (`{"action": "replace", "selector": "...", "text": "..."}`) and
  `ignoreBands: [{"y": <px>, "h": <px>}]` (CSS px, masked in both images); a gate state that uses them exits 2.
- `size: {"width", "height"}`: the viewport for a frame that is part of a page; a gate state's size must equal its Figma node's size
  (the render bounds when `spec.json` has them, else `meta.json`), else exit 2. Components outside the frames (open selects, lists,
  menus): list them in the matrix, pull their Figma nodes, and give each a state with an open step and `size` = its node's size.
- Render bounds: element rows use `absoluteBoundingBox` and stay strict. When the baseline is a render-bounds export (its size is the
  node's `absoluteRenderBounds` x scale), the capture takes the render bounds and the area outside the node box (focus ring, outside
  stroke, shadow) is judged as its own region (`effect region` in the report, same limit). A box-sized baseline prints `effect region:
  not compared`. Which Figma export holds a drop shadow (`use_absolute_bounds` true or false) is not yet probed (needs `FIGMA_TOKEN`).
- Focus (`responsive`, P3e): the focus walk fails with `focus-cap` when it reaches its cap (60 stops) before focus leaves the page,
  never a silent stop, unless the state sets `maxFocusStops: {"count": 80, "why": "<15+ characters>"}`. `focus-indicator` stays a hint
  until it has proven itself (`FOCUS_INDICATOR_FAILS` in `lib/rendered-checks.mjs`: set it once `results.md` counts 0 false alarms on
  one real screen per UI project). M3: the walk runs again with forced colours (`focus-indicator (forced colours)`, a hint).
  `focus-ring-width` (a hint, one row per width, never a failure): the width in px of the ring each stop shows on focus, the outline
  drawn or the widest solid `box-shadow` band added on focus (`outline: none` with a `0 0 0 3px` shadow is 3; a blur-only glow and a
  shadow that is there unfocused do not count; Chromium reports the default `auto` outline by its computed width, which can be less
  than it paints). The row names the widest ring and how many stops show each width; it is the margin a capture needs around a control.

## `attribute` (where the leftover pixels come from)

`ui-check attribute --results <batch or run --out> [--accepted matrix.json] [--strict]` reads `results.json` and, per compare record
with images, recounts the colour metric (any RGBA channel off by more than 2 levels, anti-aliasing counted; over every pixel for a
`rule: strict` record, outside the Figma TEXT boxes otherwise) on the image pair the gate compared (its masked or padded copies when the
capture wrote them). A recount that differs from the record's `driftPixels` exits 2. Each pixel then goes to the topmost Figma node
whose box holds it (spec.json paint order; TEXT boxes grown by 2 CSS px) and one class:
- `accepted`: an `accepted` entry of the `--accepted` matrix for the same frame and cell, with an owner decision and a `reason`
  (ui-coverage `lib/accepted.mjs`), whose pixel rule `{check:"pixel", maxPercent}` is not below the record's share. The rule may name
  `nodes: ["12:41"]` (Figma node ids): then only the pixels inside those nodes are accepted; without `nodes` every pixel is.
- `text anti-aliasing`: a TEXT node with under 20 leftover px, or one that is neither displaced (the best shift of up to 2 px is 0, 0)
  nor of other ink (actual over baseline ink outside 0.97-1.03).
- `flagged text`: a TEXT node that is displaced or has an ink change.
- `graphic`: a VECTOR, BOOLEAN_OPERATION, ELLIPSE, LINE, STAR or REGULAR_POLYGON node, or one with an IMAGE fill.
- `other`: any other node, or no node (outside the frame: padding, the effect region).

Output: per record `attribute <surface> / <state> / <locale> @<width> (rule ...): <n> px, recount matches -> PASS|FAIL (...)`, one
row per class with pixels (`| class | px | pass\|FAIL | top nodes |`) and the crop paths: the 3 biggest graphic or other clusters and
the 3 biggest flagged text boxes, each as `<n>-<class>-baseline.png`, `-actual.png` and `-diff.png` (leftover pixels in red) in the
state's `attribution/` folder, native scale and at most 2,576 px on each edge (`lib/crops.mjs` tiles a bigger region).
`<results>/attribution.json` holds the same per record. The rule is `--strict` or the record's `rule`: strict fails a record with
any flagged text, graphic or other pixel; default fails a record whose pixel gate failed unless every leftover pixel is accepted. A
size mismatch is never accepted. Exit 0 when no record fails, 1 otherwise, 2 for a usage or setup error (no results.json, no compare
record with images, a missing image or cache, a recount that differs).

`run` under the strict rule (`--strict` or the matrix's `rule: strict`) attributes, after the batch, every failing strict compare
whose only failing finding is the pixel finding, with the matrix's accepted entries. One that passes the class rule (every leftover
pixel accepted or text anti-aliasing) becomes a `pass` record without its pixel finding and with `attribution` (px per class);
`results.json`, `summary.md` and `ledger.json` are rewritten before `ui-coverage check` reads them. The class rows are printed after the
counts line; a recount that differs exits 2.
