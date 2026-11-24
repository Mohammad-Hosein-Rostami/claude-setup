---
name: figma-pixel-perfect
description: Use when a task has a Figma link, frame or node id, or says match the design / pixel perfect - pull the baseline, build, compare with ui-check and fix until it passes. The state matrix is ui-coverage.
---

When the check plan is pixel (design words in the request, or a look change on a surface with a Figma frame: `standards/ui-checks.md`), with no switch: pull the Figma baseline, build to it, run the `ui-check run` compare loop and the responsive checks, then the `pixel-qa` final gate.

Rules: U1, U2, F7. Conversion rules, tolerances and false positives: `standards/figma.md` (read it once per task).
Tools: `node ~/.claude/tools/ui-check/cli.mjs <cmd>`, `ui-coverage/ui-coverage.mjs`, `ui-proof/ui-proof.mjs` (READMEs beside them).
Never print `FIGMA_TOKEN`. Images: only crops of failing rows, at native scale (1:1 device pixels), each at most 2,576 px on the
long edge, never a full page at device pixel ratio 2; a crop explains a row, PASS and FAIL are the ui-check numbers.

0. **Matrix.** Invoke `ui-coverage`: `ui-coverage init <matrix> ... --frames frames.json --breakpoints <the project's>` (add
   `--rule strict` when the owner said exact, pixel perfect or پیکسل); `ui-coverage conditions` records the owner's viewing
   conditions once per project. Every frame, hidden UI, controls, states, locales. Lanes split by file ownership: a lane owns a
   set of files and its states are the screens those files render, not a count of screens.
1. **Pull once.** With a token: `figma-pull --bulk --file KEY --node ID` (frames and component variants; cache
   `~/.cache/figma/KEY/ID/`, `:` becomes `-`); `figma-refresh` later says which baselines changed. No token: a Figma export with
   `figma-pull --from-export DIR`, or MCP `get_metadata` + `get_variable_defs` + `get_screenshot` saved into the same layout
   (`baseline.png`, `spec.json` with x/y/w/h relative to the root, `meta.json` {scale,width,height}).
2. **State gallery** (any job with more than a few states): every Figma state at its own URL with Figma's sample data, a frozen
   clock and a ready marker, behind a development flag that a product test proves does not ship (the gallery and its test live in
   the product). On MUI the capture build only uses the **MUI capture preset**: transitions off through the theme helper (with
   CssBaseline), ripple off, fonts awaited, clock frozen. `ui-check first-paint` runs without the preset: transitions are part of
   what it checks.
3. **Calibration** before lanes start: compare one state, fix the harness's false positives in the map (`map.json`, skips),
   then `ui-check figma-diff` lists parts and texts missing from Figma or the build.
4. **Design-system-first step** (design-system project): list the components the frames use; compare each variant (one story or
   gallery state per variant) with its Figma variant from `figma-pull --bulk`; fix every difference in the theme or the shared
   component, never per screen. Then the screen baseline.
5. **Baseline**: `ui-check run --matrix M --base-url U --out <ref>` on the base tip. Its table (per state: pixels, rows, known causes) goes into every lane brief and `<ref>`
   is the lane's `--no-worse` reference. Shared root causes found there (fonts, rasteriser, a design-system component) get their
   own first step before lanes tune screens.
6. **Implement** with tokens (Code Connect and MUI theme tokens over hard-coded values); stable selectors (`data-testid`) on
   mapped elements; interactive states from the frame (see the standard). `get_design_context` once per node, only if unclear.
7. **Batch loop** (the UI lane owns it): one `ui-check run --matrix M --base-url U --prev <last round> --no-worse <ref>` per round
   (`--strict` under the strict rule; `--self-test` once to prove captures are stable). Fix only failing rows, one root cause per
   round (a wrong font moves everything: fix it first). No round limit: repeat until every state passes the rule in force (0
   element rows outside accepted ones, and the pixel rule: 0.5% default or strict). Every round prints identical / better / worse
   against the reference. **Plateau** (`PLATEAU`: no gain in 2 rounds): change approach (`dev-debug` on that state; font
   files, hinting, subpixel layout, image sources; `ui-check attribute` for strict leftovers), keep working on other states,
   never lower the bar (`--max-diff`, the rule, the matrix), never mark it passed. Only a proven renderer-level cause is an open
   item with evidence; stop early only for a blocker outside the code (missing font or asset, unclear design), then ask. Text 1px
   high at some size/line-height pairs: shared `descent-override` and font smoothing, never per-element nudges (standard: "Text
   baseline and smoothing"). Exit 0 pass, 1 fail, 2 setup error (fix the setup, do not retry blindly).
8. **Responsive.** The matrix widths run inside `run`; `responsive --url URL --widths <defaults>,<frame widths>` for a single
   page; fix findings per `responsive-ui`. Tables: `columns --url URL --table SEL`.
9. **Accepted differences**: one row each with a reason (`ui-coverage` `lib/accepted.mjs` requires one) and a diagnostic proof
   (a diagnostic state), plus a "settled, do not report again" list for the owner. No owner approval during the work: the final
   report lists every accepted difference with its reason, and the owner checks them when the work is done.

The UI lane owns the batch loop; pixel-qa runs the independent final gate on the tree that lands (the lane rebased onto
the current base; same matrix, URL, widths), writes the review page (`ui-proof review-page`) and only its PASS counts
(`ui-proof check` holds it). A pixel-qa failure goes back to the UI lane's loop.

## UI brief template (the lead fills every field)

- Spec path; skills to load (named: a project copy of `dev-pixel` shadows its preloads); worktree and port (dev URL); Figma URL + node and the ui-check cache; reference app; states file;
  matrix (`MATRIX: <path>`).
- The per-state baseline table and known causes (step 5); a per-node target table (node, selector, "Now" px).
- Acceptance numbers: "N states, X px, R rows, not worse" against `<ref>`.
- Every state, failure paths included (script fails, long list, forced colours, no script).
- The owner's words verbatim; owner decisions that bind the lane; the file scope; the hand-over note path.
- Shared-machine rules: other lanes' ports, kill only your own processes.
- Token check (design-system project): a raw colour, px size or font value in `sx`, `styled` or an inline style where a theme
  token exists is a failing row naming the token; an exception needs a reason.
- Report format: verdict, last `result:` and `frames:` lines, `results.json` path, open items with evidence.
- The owner gets a live page (the review page of the final gate).

Done-gate: the lane's last `run` PASS (or open items with proven causes), then pixel-qa's final-gate PASS on the tree that lands
with its review page path, commands and verdict lines quoted.
