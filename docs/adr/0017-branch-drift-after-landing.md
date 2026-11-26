# 0017: Branch drift after landing: the tick blocks only on main and shows test branches, Fix pieces keep their repro branch, land names patch-landed folds

- Status: accepted. Date: 2026-11-27. Builds on 0004 (one content proof), 0010 (round loop), 0014 (interim helpers).

## Context

A two-repo job (bases `develop` and `master`, 81 lands in one day) ended with stalled lanes, many leftover `test/*` branches
and 30 locked snapshot folders (the job's plan and diagnosis notes, kept outside the repo).
The tick said `fix main first` on every call because of an old tangled side branch, so the boss stopped running it. Fix briefs
cherry-picked repro branches into `lane/<fix>` because the tick counts only `lane/<id>` lands; when later commits changed the
same test files, land's content proof no longer held and `left:` called them `idle, ahead 1`. After an API outage, 4 resumed
agents ended "waiting" and their helpers' results went to the boss. In a second repo (base `develop`), tess-write's passing
`test/*` branches and a repro whose Fix landed elsewhere stayed: tess-write works outside the lane pool, and the tick shows
only pool folders and `lane/<id>` pieces, so a test branch landed only when the boss remembered tess's report.

## Options and decision

- D1, what blocks the tick's `next:`: any finding (old) / main's own kinds, the rest on a `tidy` line (chosen) / a waiver file.
  A side ref no land can fix must not stop the round; a dirty base, an unpublished merge on main or a stale checkout still do.
- D2, folds that landed as patches: keep ADR 0004's one content proof; label them `landed as patches ...` with the hand step.
  Rejected: delete on patch equality (deletes a fold whose change the lane removed before landing), and a proof at a past base
  position (history proofs, rejected in 0004).
- D3, Fix pieces: a piece may name `"branch"`; the tick counts its land. Rejected: rules alone (they were not followed).
- D4, early stops: keep 0014's keep-alive; after any resume an agent starts a new one, and the boss treats a `completed`
  notice that still waits as a stopped agent and forwards its helpers' results. Rejected: foreground waiting (polling), a hook.
- D5, test branches nobody lands (a second repo on base `develop`): the tick lists every `test/*` branch not landed and puts
  them in `next:`, and tess's report gives one `land:` line per passing one. Rejected: tess-write in pool folders (the tick
  would say `land` for a failing repro), rules alone.

## Consequences

- Good: no `test/*` branch with work is out of sight; the boss can follow the tick literally; Fix pieces land under the
  repro's name, so land deletes the repro branch; each remaining fold names its hand step; stalled agents get resumed with
  their results.
- Bad: patch-landed folds still need a person (`git branch -D`); the rule for resumes lives in 8 agent files; side findings
  stay visible until someone runs prune or decides on them.

## Reversal

- A side finding hid a real break of main: block on it again.
- Hand deletes of patch-landed folds pass about 3 a day: add the past-base-position proof.
- `early-stops.mjs` still counts early stops with no resume before them: use 0014's option (b) for the runners.
- A `test/*` branch stays a day while the `tests not landed` line shows it: the boss needs a hard stop, not a hint.

## Sources

- The session transcript bb1a4bd5 (2026-11-26), its subagents, the land ledgers and deletion logs (the diagnosis notes, section 6).
- `home/tools/board/lib/tick.mjs` (`nextLine`), `tick-features.mjs` (`laneBranch`), `home/tools/land/sweep.mjs`, ADR 0004.
- git-scm.com/docs/git-cherry and git-rev-list `--cherry-mark` (patch ids ignore whitespace), git-scm.com/docs/git-merge-tree.
