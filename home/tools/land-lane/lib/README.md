# land-lane/lib

Parts of `../land-lane.mjs`; the tool's own README is `../README.md`.

- `args.mjs`: reads and validates the command line (`parseArgs`, `isAbsolutePath`); a bad value is a `UsageError` (exit 2) before any command runs.
- `checks-step.mjs`: the done-check step after the rebase (`checkRebasedTip`, `assertReviewedIsAncestor`): exit 4, 10 or 14, or the lines and row evidence.
- `union-rows.mjs`: the tip-object and union-row step (`checkTipRows`, `verifyTipObjects`, `unionDuplicateKeys`): exit 12 for a table row key twice in a `merge=union` file, exit 14 for a missing object.
- `stop.mjs`: `Stop` and `stop(...)`, a refusal with its exit code.
- `tools.mjs`: `git(...)` and `tool(name, script, args, ...)` run one subprocess with no shell, a timeout and no `GIT_*` variables of the caller.
- `ui-plan-step.mjs`: the UI check plan of a landing (`laneMatrix` from the road beside STATUS.md, `requireBriefForApp`, `planAt`, `restartPlan`): exit 2 for an app change with no readable brief, exit 14 for a plan that cannot be computed.

Run the tests with `node --test tests/land-lane.test.mjs tests/land-lane-units.test.mjs tests/land-lane-done-check.test.mjs tests/land-lane-union-rows.test.mjs tests/land-lane-ui-plan.test.mjs`.
