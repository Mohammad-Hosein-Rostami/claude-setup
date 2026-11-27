# Refactor (R1-R4)

- **R1** Characterization tests pin current behaviour before the move (tess-write writes and runs them where dev runs no tests;
  dev names them); no feature change in a refactor commit.
- **R2** Small reversible steps (parallel change); each commit is whole: every user of a changed name updated,
  tests included (dev changes only the name in a test, by reading).
- **R3** Remove duplication and dead code inside scope; don't rename or move outside it.
- **R4** Public exports stay the same unless the task says otherwise.
