# Database (D1-D7)

- **D1** Every schema change is a new forward migration file. Never edit an applied one.
- **D2** Expand -> migrate -> contract. Add the new column first; drop or rename in a later release.
- **D3** Migrations are transactional where possible, idempotent, with a rollback or forward-fix plan.
- **D4** Put constraints in the database: NOT NULL, FK, UNIQUE, CHECK; timestamptz, numeric for money.
- **D5** Index every FK and query predicate; look at EXPLAIN for hot queries; avoid N+1.
- **D6** Backfill in batches that can resume; `CREATE INDEX CONCURRENTLY` to avoid long locks.
- **D7** No concatenated SQL; wrap multi-write invariants in a transaction.
