# home/tools/road/lib

The parts of the `road` tool, which walks a big job as fixed steps of 1 to 5 lanes with a gate between steps.
`../road.mjs` is the command and `../README.md` has the options. Plain Node, no dependencies; programs to run are passed in.

- `road-file.mjs`: reads and checks a `road-<id>.json` file (steps, lanes, files, checkpoints) and lists the problems and warnings.
- `road-state.mjs`: where a road stands, from the STATUS.md rows: the current step, its lanes, held and carried lanes, landed ranges.
- `road-gate.mjs`: the checkpoint between steps; one PASS, FAIL or INFO line per check, and any FAIL fails the gate.
- `road-join.mjs`: judges one built lane's scope for `road.mjs join`: files outside the lane and the count of its UI files.
