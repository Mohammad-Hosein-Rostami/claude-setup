# 0014: The tick holds a risky feature's files until tess returns; a parent keeps itself running for an interim helper

- Status: accepted. Date: 2026-11-26. Builds on 0010 (the lane pool, the round loop and the snapshot lanes).

## Context

- `board tick` called pieces startable while their files belonged to a landed risky feature whose tess round was still out,
  and the boss held them by hand.
- Agents reported "still waiting" as their final report again and again: `early-stops.mjs` lists 16 such notices since
  2026-11-25, most of them real. When a helper stops while its own background command still runs, its notice says it
  `is waiting on its own background work`, with status `completed`. From then on the helper no longer counts as running for
  its parent, so the parent's next end of turn is final, and its "still waiting" text reaches the boss as its report.

## Drivers

Hold:

1. The hold lasts until tess returns, not until it starts.
2. No new boss step or stored file.
3. A doubt holds (fail safe).
4. Simple.

Early stops:

1. The parent keeps waiting until the helper's final result.
2. Instruction wording only.
3. Works at every depth (dev-pixel starts pixel-qa, dev-part starts dev-run).
4. Few tool calls, and no polling (the owner's rule).

## Options

Hold:

- (a) The release of the snapshot lane claimed at the feature's tess mark ends the hold. The boss already releases it after
  tess returns, and it is a git fact (the worktree's lock reason): nothing new is stored, and an unreleased lane holds.
- (b) A `--tess-done <feature>` record. One more boss command and a second marks field to keep right; a forgotten call
  holds forever with no visible cause.
- (c) A running tess agent on the board. No agent is linked to a feature, and a tess between turns can read as done, which is
  exactly the early-stop state.

Early stops:

- (a) On an interim notice the parent starts one background keep-alive (`node -e "setTimeout(() => {}, 7200000)"`,
  `run_in_background: true`, `timeout` 7200000). With work of its own still running, its stop is interim too, and the
  helper's later notice resumes it; it stops the keep-alive with TaskStop once every helper has returned.
- (b) Helpers never stop while their own command runs: they wait in the foreground in calls under 3 minutes. It is a sleep
  loop, against the owner's rule; a 1-hour Codex run costs about 21 wait calls; it cannot cover a helper that waits on its own
  agent helper; and it changes about 15 files.
- (c) A tool or a hook. The owner wants no tool unless clearly needed, and (a) needs none.

## Decision

(a) for the hold and (a) for the early stops.

- The tick holds a feature whose risk is not `none` (by the plan, or by the `risk` tool on its land ranges) once it has a
  land, until a tess mark covers every land and the snapshot lane at that mark's sha is released. The held files are the
  declared files of its landed pieces plus every file its lands changed. A piece or lane on those files is not startable and
  not suggested for landing, across every plan the tick is given (`--plan` repeats).
- The 8 agent files that start helpers (lex, dev, tess, max, dev-part, dev-debug, dev-ui, dev-pixel) say that such a notice
  is no result, and give the keep-alive sentence.

## Consequences

- Good: the tick blocks held claims and lands across jobs, with no new boss step. Parents report once, with the result. No
  polling, no tool.
- Bad: a snapshot claimed at a sha other than the mark's lifts a hold early (the boss uses one sha for both). Each interim
  helper costs one keep-alive start and stop. The rule lives in 8 agent files.

## Reversal

- The boss starts releasing snapshot lanes before tess reports: then use hold option (b).
- `early-stops.mjs` still counts early stops after the keep-alive rule landed: then add early-stop option (b) for the runners.
- Update 2026-11-27: the signal fired only for agents resumed after an API error; see 0017 (D4).
- Update 2026-11-27: a hold now ends when tess records `done` (not at the snapshot's release), and the tick prints the
  boss's steps; see 0019.

## Sources

- Claude Code 2.1.330's notification text (the `is waiting on its own background work` summary and its interim note), read
  in plan-board-hold.md section 2.
- The transcripts of session 195936cb, the agents listed in plan-board-hold.md section 2.
- git-scm.com/docs/git-worktree (`list --porcelain`: `locked <reason>`).
- plan-round1-fixes.md section 6 (the snapshot lanes and the tess marks).
