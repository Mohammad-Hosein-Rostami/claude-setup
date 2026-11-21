---
name: road
description: Walk a big job as a road of steps - each step one build run of 1-5 lanes, a gate between steps, one update per step. Use when a job needs more than one step (2+ lanes that fit one step are one build run).
when_to_use: The architect wrote a road-<id>.json beside STATUS.md, or a job needs more than one step of lanes; also to pick a road up in a new session.
argument-hint: <road-<id>.json path>
---

A road is the job's plan: `road-<id>.json` beside the job's STATUS.md (format: `~/.claude/tools/road/README.md`), every
step fixed at the start. A step is one `build` run of 1-5 lanes that share no file (except `appendOnly`) and use only
contracts an earlier step landed. The STATUS.md rows hold the state; the tool is `node ~/.claude/tools/road/road.mjs`.

## Start
1. `road.mjs check <road>`: fix every refusal with the architect before anything runs.
2. The start line: show the owner the steps and lanes, one line each (`step N: <goal> - <lane>, <lane>`), beside the
   start questions (the road's `questions`, all asked now, each with its recommended option).
3. `road.mjs rows <road>`: adds every row of every step (a second run adds 0).

## Walk
Run `road.mjs next <road> --budget <n>`: n is your mode's lane budget (normal 2, medium 3, the others 5); after
phase 6 removes modes, 5. It prints the step to run (`state: build`), that the gate is due (`state: gate`) or
`done`. Never more than 5 lanes in one run (`build` refuses 6).

Two step forms (the step's `form`):
- `build` (default): one `build` run with the printed `args` (add `scriptsDir`); its lanes land through `land`.
- `agents`, a step the owner steers while it runs: the same lanes as plain background agents, each reviewed to clean
  (the `reviewed <sha> clean` line) and landed through `land` one at a time.

## Gate and update
When every lane of the step landed: `road.mjs gate <road> --step <N>`. Every line must PASS; the next step starts only
then. After the gate: one update to the owner with the `Finish:` block of `estimate.mjs STATUS.md` pasted as-is, and a
`status.mjs deliver "<step N done>"` row.

## Failure and carry
- A FAIL line holds the step: fix what it names (a rework lane: `road.mjs rows <road> --fix <N> <name>`), then run the
  gate again. A gate is never skipped and never edited to pass.
- A lane that did not land in its run is carried: `next` lists carried lanes first in the next run of the same step. A
  UI lane is never carried past its visual-qa PASS.
- A `build` lane that fails `wrong base` ran off the base checkout: keep the session on the base checkout, run again.
- A step changes only before it starts (the architect edits the road, then `check` again).

## New session
Read STATUS.md `## Standing rules`, then `road.mjs next <road> --budget <n>`: landed lanes are skipped, the open step
and its carried lanes come back; resume a stopped `build` run with `wf-resume` before starting a new one.
