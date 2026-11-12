---
name: figma-pixel-perfect
description: Use whenever a task has a Figma link, frame or node id, or says match the design / pixel perfect - pull the baseline, build, compare with ui-check, fix until it passes, then check responsive.
---

Rules: U1, U2, F7. Conversion rules, tolerances and false positives: `standards/figma.md` (read it once per task).
Tool: `node ~/.claude/tools/ui-check/cli.mjs <cmd>` (README beside it). Never print `FIGMA_TOKEN`.

1. **Pull once.** With a token: `figma-pull --file KEY --node ID --scale 1` (cache: `~/.cache/figma/KEY/ID/`; `:` becomes `-`).
   No token: MCP `get_metadata` + `get_variable_defs` + `get_screenshot`, saved into the same layout
   (`baseline.png`, `spec.json` with x/y/w/h relative to the root, `meta.json` {scale,width,height}).
2. **Structure.** `get_design_context` once per node, only if structure is unclear. Prefer Code Connect and MUI
   theme tokens over hard-coded values. Read interactive states from the frame (see the standard).
3. **Implement** with tokens; give mapped elements stable selectors (`data-testid`).
4. **Compare.** Write `map.json` (`{"<figmaId>": "<selector>"}`, ids from `spec.json`), start the dev server only if
   it is not running, then:
   `compare --url URL --root SEL --cache DIR --map map.json --project .`
   Exit 0 pass, 1 fail, 2 setup error (fix the setup, do not retry blindly). Read `report.md` only; never open
   `diff.png` or `actual.png` unless the table is empty and the verdict is FAIL.
5. **Fix** only the failing rows, one root cause per round (a wrong font moves everything: fix it first). At most
   No round limit: repeat compare and fix until it passes; the result matters more than speed. If a round fixes
   nothing, change approach rather than repeat it (recheck the root cause, re-pull the spec, check the
   false-positive list). Stop early only when blocked by something outside the code (missing font or asset,
   unclear design); then ask. Do not loosen `--max-diff` to pass.
6. **Responsive.** `responsive --url URL --widths <defaults>,<frame widths>`; fix findings per `responsive-ui`.
   Tables: `columns --url URL --table SEL`.

Delegate steps 4-6 to the `visual-qa` agent when the main context is large: it returns at most 20 lines.

Done-gate: `compare` PASS (or remaining rows listed with causes), `responsive` PASS or findings listed, commands
and verdict lines quoted; then `verify-done`.
