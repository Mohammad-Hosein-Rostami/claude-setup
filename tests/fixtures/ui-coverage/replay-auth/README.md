# replay-auth

A frozen copy of a UI hand-over that was reported done with Figma misses, used by `tests/ui-coverage-replay.test.mjs`.

- `matrix.json`: 4 auth surfaces x en,fa at 1440; 6 frames listed, one with no cell, one marked not built; one accepted difference.
- `frames.json`: the 8 frames of the design (2 of them are not in the matrix).
- `results.json`: rest cells passing on probe evidence (no `part`), plus 2 failing compare records.
- `queue.jsonl`: the decision queue; q2, which the accepted difference points at, was never answered.

`ui-coverage check matrix.json --results results.json` must exit 1.
