# Refactor (R1-R4)

- **R1** Current behaviour stays: dev reads every caller of the code it moves and names the tests that pin it, for tess after
  the land; no test is written or run before the move. No feature change in a refactor commit.
- **R2** Small reversible steps (parallel change); each commit is whole: every user of a changed name updated,
  tests included (dev changes only the name in a test, by reading).
- **R3** Remove duplication and dead code inside scope; don't rename or move outside it.
- **R4** Public exports stay the same unless the task says otherwise.
