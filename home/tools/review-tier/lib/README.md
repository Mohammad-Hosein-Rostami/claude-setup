# review-tier/lib

The parts of the `review-tier` CLI (see `../README.md`): `diff.mjs` reads git (ranges, deltas, required reading),
`reviews.mjs` turns classes into reviews and plans, `report.mjs` builds and prints the report, `log.mjs` appends the log
line. `../tiers.mjs` holds the class rules. `report.mjs` and `reviews.mjs` are pure: test them with fabricated diffs,
`diff.mjs` with a throw-away git repo (`tests/review-tier.test.mjs`).
