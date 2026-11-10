---
paths: ["Dockerfile*","**/.github/**","**/*.tf","**/*.yml"]
---
# Infra rules: id | rule | check
I1 | Everything as code; reproducible builds; pinned versions | hadolint, actionlint
I2 | Containers: non-root, minimal, no secrets | hadolint
I3 | CI runs lint, typecheck, test, audit per PR | review
I4 | Least-privilege tokens; pin actions by SHA | zizmor
I5 | Env config with .env.example; fail fast | zod env
I6 | Rollback path and flags for risky deploys | rev
