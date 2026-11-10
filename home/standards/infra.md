# Infra / DevOps (I1-I6)

- **I1** Docker, CI and IaC are code; pin versions or digests.
- **I2** Non-root user, minimal base, multi-stage build, no secrets in layers, HEALTHCHECK.
- **I3** Every PR runs lint, typecheck, test, audit; cache dependencies.
- **I4** Least-privilege tokens; pin third-party actions by commit SHA.
- **I5** Document env in `.env.example`; parse env at boot and exit on missing values.
- **I6** Plan the rollback; use feature flags for risky deploys; no manual prod steps.
