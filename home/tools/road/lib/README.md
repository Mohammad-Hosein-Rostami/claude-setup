# home/tools/road/lib

The parts of the `road` tool, which walks a big job as fixed steps of 1 to 5 lanes with a gate between steps.
`../road.mjs` is the command and `../README.md` has the options. Plain Node, no dependencies; programs to run are passed in.

- `road-file.mjs`: reads and checks a `road-<id>.json` file (steps, lanes, files, checkpoints) and lists the problems and warnings; `roadClash` says why
  two roads cannot both be open in one STATUS.md.
- `road-state.mjs`: where a road stands, from the STATUS.md rows: the current step, its lanes, held and carried lanes, landed ranges,
  and the one landed rule (`laneLanded`: in an old-form road a lane's `-land` close row, else its own lane row with a landed line; never a
  `rework:` row) that the gate and the board read, with the `.landed` correction rows (`correctionRows`), and the early lanes
  (`earlyLanes`: later-step lanes whose needs landed, confirmed in git by `needsNotOnBase`, and whose files no open lower lane holds,
  to fill up to 5 agents), and the lanes in flight (`inFlightBranches`) for gate line 3. `road-file.mjs` `filesShare` is the one overlap
  rule of `check` and early lanes.
- `road-gate.mjs`: the checkpoint between steps; one PASS, FAIL or INFO line per check, and any FAIL fails the gate. Line 2 also counts
  the landings of the other roads beside STATUS.md (two roads at once).
- `road-gate-ui.mjs`: gate line 4, the UI proof: `ui-proof check` for web UI (any landing of the step, fix rows included), or the
  owner-approved terminal proof row of a terminal UI step (render in the job folder or the reports tree, dated, on record under
  `## Owner decisions`).
- `road-join.mjs`: judges one built lane's scope for `road.mjs join`: files outside the lane and the count of its UI files.
