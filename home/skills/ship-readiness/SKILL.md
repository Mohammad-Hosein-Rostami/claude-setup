---
name: ship-readiness
description: Use before shipping work to real users, or for a production-readiness review - release quality, rollout and rollback, config and secrets, observability, capacity, dependencies, the go/no-go. Preloaded by max; lex loads it for a plan with `ship:`.
---

One checklist for a release, a deploy, a publish or a showcase for real users, built from Google's production readiness review
and AWS's operational readiness review. Mark every item `pass`, `fixed`, `gap` or `n/a (why)`, with its evidence (a command and
its result, or `path:line`). "Not run" is never a pass. The project's own release process and checklist win where they exist.

1. **What ships**: the landed sha, tess's verdict on that same sha, the target (environment, registry, host or showcase), and
   who uses it.
2. **Release quality**: a reproducible build from a clean checkout and a frozen install (I1); the built artefact installs and
   starts; the version follows the repo's own scheme (SemVer when it uses it); changelog and release notes (X9); migration notes
   for a breaking change.
3. **Change safety**: rollout in steps where the platform allows it (canary or phased); a flag for a risky path; the blast radius
   named. The rollback path is rehearsed (previous artefact, down migration or restore on a copy, flag off) and has a trigger
   (I6, the D rules in `~/.claude/rules/db.md`).
4. **Config and secrets**: every env name the code reads is set for the target (`env-names diff`, names only, never values); no
   secret in the artefact or its logs (I2, C15); dev-only mocks and showcases are absent from the production build (the
   `ui-quality-pass` Done-gate).
5. **Operability**: logs on new paths, without secrets; a health check; an alert on user-visible failure; a runbook for a new
   manual operation (the Documents table in `~/.claude/standards/readability.md`); who is called when it breaks.
6. **Capacity and performance**: one measured number against the project's stated budget (web: `frontend-performance`; an API:
   latency at the stated load). A load test only when the plan names a scale.
7. **Dependencies and limits**: versions pinned and audited (tess `deps`); external quotas and limits checked with two sources
   (lex-web).
8. **The user path**: the main flows open on the built artefact; first run, empty and error states; the quickstart in the docs
   matches what the artefact does.

Run the checks on a local copy or a staging the owner names, never on real data or a live system. Outward steps (push, tag push,
publish, deploy, PR merge, production writes, a migration on real data) are prepared as exact commands, never run, unless the
brief carries an `owner-command:` for that action.

Done-gate: every item marked with evidence; no `gap` left without the owner's yes; outward steps only on an `owner-command:`; "not run" never counts as pass.
