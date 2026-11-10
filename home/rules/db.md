---
paths: ["**/migrations/**","**/*.sql","**/schema.*","**/prisma/**"]
---
# Database rules: id | rule | check
D1 | Schema changes are forward migration files; never edit applied ones | CI
D2 | Expand, migrate, contract; no drop/rename with the code change | squawk
D3 | Idempotent migrations with a rollback plan | CI
D4 | Constraints in the DB: NOT NULL, FK, UNIQUE, CHECK | schema lint
D5 | Index every FK and query predicate; avoid N+1 | EXPLAIN, rev
D6 | Batched backfills; CREATE INDEX CONCURRENTLY | squawk
D7 | No concatenated SQL; transactions for invariants | semgrep
