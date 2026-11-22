---
name: road
description: Walk a big job as a road of steps - each step one batch of 1-5 agents, a gate between steps, one update per step. Use when a job needs more than one step (lanes that share no file fit one step).
when_to_use: The architect wrote a road-<id>.json beside STATUS.md, or a job needs more than one step of lanes; also to pick a road up in a new session.
argument-hint: <road-<id>.json path>
---

A road is the job's plan: `road-<id>.json` beside the job's STATUS.md (format: `~/.claude/tools/road/README.md`), every
step fixed at the start. A step is 1-5 lanes that share no file (except `appendOnly`) and use only contracts an earlier
step landed. The STATUS.md rows hold the state; the tool is `node ~/.claude/tools/road/road.mjs`.

## Start
1. `road.mjs check <road>`: fix every refusal with the architect before anything runs.
2. The start line: show the owner the steps and lanes, one line each (`step N: <goal> - <lane>, <lane>`), beside the
   start questions (the road's `questions`, all asked now, each with its recommended option).
3. `road.mjs rows <road>`: adds one row per lane and one check row per step (a second run adds 0). `status.mjs start` a lane row when its
   writer starts; never mark it done by hand before it has landed.

## Walk
1. `road.mjs next <road> --budget 5` names the step and its lanes (at most 5 agents at once; the hook refuses a 6th).
2. Build batch: one writer per lane, each brief from the lane's contract.
3. `road.mjs join` per lane (judges the lane's scope; exit 3 gives its findings back to the writer).
4. `land-lane --close-row <road>.s<N>.<name>` per lane, one at a time: it writes the lane row's `landed <to> on <base> from <from>`
   evidence (old-form roads, with `-land` rows from before one row per lane: their close row).
5. `road.mjs gate <road> --step <N>`, then a `deliver` row.

Resume after an exit: `road.mjs next`, each open lane's row, branch tip, `HANDOFF-<row>.md` and last report. A live agent
of the same session is continued with SendMessage.

## Gate and update
When every lane of the step landed: `road.mjs gate <road> --step <N>`. Every line must PASS (it checks that every lane landed, and the other lines the road README lists); the next step starts
only then. After the gate: one update to the owner with the `Finish:` block of `estimate.mjs STATUS.md` pasted as-is, and a
`status.mjs deliver "<step N done>"` row.

## Failure and carry
- A FAIL line holds the step: fix what it names (a rework lane: `road.mjs rows <road> --fix <N> <name>`), then run the
  gate again. A gate is never skipped and never edited to pass.
- A lane that did not land in its step is carried: `next` lists carried lanes first in the next run of the same step. A
  UI lane is never carried past its visual-qa PASS.
- A lane that fails `wrong base` ran off the base checkout: keep the session on the base checkout, run again.
- A step changes only before it starts (the architect edits the road, then `check` again).

## New session
Read STATUS.md `## Standing rules`, then `road.mjs next <road> --budget <n>`: landed lanes are skipped, the open step
and its carried lanes come back.
