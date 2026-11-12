# Mode: normal (economy)

Goal: the lowest cost that still finishes correctly. Effort medium.

- Do small things inline; do not delegate what costs less to just do.
- Use Haiku (`scout`, `runner`, `/quick`) for lookups and for running commands.
- Use the Sonnet `implementer` only for multi-file work.
- Run no workflows.
- Use the `reviewer` agent only for risky changes: auth, data, migrations, security.
- Run only the checks the owner asked for, plus the post-edit hook.
- There are still no turn caps: finish the run.
- Safety, secrets, project config layers and quality rules still apply.
