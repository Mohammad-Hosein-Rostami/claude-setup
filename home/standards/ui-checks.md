# UI checks: how closely a change is checked (the check plan)

Nobody labels a lane. `node ~/.claude/tools/ui-proof/ui-proof.mjs plan` reads three kinds of evidence and returns the check plan,
whose depth fits the change: `none` < `same` < `render` < `visual` < `pixel`. The code is `tools/ui-proof/lib/ui-plan.mjs`; the
vocabulary (file and line classes, request words) is `lib/ui-evidence.mjs`.

## Evidence

- **Request**: the brief (it quotes the owner's request) and the STATUS.md sections `## Standing rules` and `## Owner decisions`.
  Design words (a figma.com link or node id, Figma, pixel perfect, match the design or frame, FA فیگما, پیکسل, مطابق طرح) and
  no-change words (refactor, no visual change, same look, FA بدون تغییر ظاهر). Talk about the checks and negated clauses give nothing.
- **Diff**: `git diff -U0 --no-renames base..tip` at the rebased tip; each file is test, docs page, dev config, deps, global look,
  look, text or logic. A renamed file is a delete and an add, so it is always a change. An app line that fits no class is look.
- **Screens**: inferred from the project at the commit (routes, matrices, stories, e2e specs; nothing run or written in the project)
  and the screens each changed file reaches by a full import walk.

## The plan (per reached surface, the strictest rule that applies)

| need | when | proof | who runs it |
| ---- | ---- | ----- | ----------- |
| none | only test, docs page or dev config files changed, or the repository has no UI file | none; exempt files listed | - |
| same | dependencies only (every surface), or a no-change request | the tip run's renders identical or equal (0 px) to the base run's, every state | runner |
| render | logic, text or look reaching a surface with no design; global look reaches every surface | no new finding, no more page errors, no missing state; old findings are `follow-up:` lines; logic: done-check tests ok | runner |
| visual | a reached screen with no base render (new), or with no url to open | today's chain: ui-implementer loop, visual-qa PASS | ui-implementer, visual-qa |
| pixel | design words in the request, or a look change reaching a surface with a Figma frame | today's full chain, unchanged: figma-pixel-perfect, ui-check rounds, visual-qa PASS | ui-implementer, visual-qa |

- A stricter proof satisfies a weaker need: a visual-qa PASS proves `render`, never `same`.
- Safe paths, never a block for a missing map, each with one reason line in the plan: reach unresolved renders every inferred route;
  no inferable route at all, or a screen without a url, takes the visual plan; evidence that cannot be read (git, the request over
  1 MB, the lane matrix) takes the pixel plan.
- The brief may raise the plan with a line `UI-PLAN: <depth>`; it never lowers it, and a value that is not a depth is ignored with a
  reason line. Request text only raises (P14).

## Flow

1. Brief time (lead): `ui-proof plan --files <expected files>... --request <brief> [--matrix <lane matrix>]` gives the expected plan.
2. Proof time (runner, after the lane is rebased), for `same` and `render`: `ui-proof plan --base <B> --tip <T> --write-run <name>`
   writes `matrix.json` and `states.json` under `~/.claude/state/ui-plan-runs/<name>/`. In the base checkout at the base tip
   `ui-check run --matrix <m> --states <copy> --base-url <U> --out <base>`; in the lane worktree the same with `--out <tip> --same <base>`.
3. Check: `ui-proof check --tip <T> --plan --base <B> --request <brief>` exits 0 with `follow-up:` lines for old findings, 1 with
   the failing states and the reason. Only runner and visual-qa records count, at the base and at the tip (head and UI tree).
