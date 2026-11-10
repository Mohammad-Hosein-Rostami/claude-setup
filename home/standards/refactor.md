# Refactor (R1-R4)

- **R1** Write characterization tests first, green before and after; no feature change in a refactor commit.
- **R2** Small reversible steps (parallel change); each commit builds and passes.
- **R3** Remove duplication and dead code inside scope; don't rename or move outside it.
- **R4** Public exports stay the same unless the task says otherwise.
