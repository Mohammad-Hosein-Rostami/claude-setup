# Mode: extra-high (lead Opus 5.5 at max; full speed, never wasted)

Same quality gates as every mode (see the lead rules and CLAUDE.md). Unlike normal/medium/high, this mode also sets the lead (Opus 5.5 at effort max, set by `ccm extra-high`) and sends important jobs to agents on Opus at max.

- Opus-max escalation, per Agent call `model: "opus", effort: "max"`, for jobs that need it:
  - architecture and planning (`architect`); hard or failed-once bugs (`deep-debugger`);
  - risky or final reviews (`reviewer`: auth, data/migrations, money, concurrency, security, or the last review before
    merge/push; routine reviews stay on Sonnet) and security audits (`security-auditor`);
  - risky or cross-module code (`implementer`); important decisions.
- Everything else keeps its pinned model: Sonnet workers, Haiku for mechanical work. No duplicate agents.
- Parallelism, workflows and report brevity as in high (short final answer, detail in files): wide fan-out in one message; Claude starts a workflow itself for
  substantive multi-part tasks, no size limit. Choosing `ccm extra-high` or `/mode extra-high` is the user's standing
  request for this.
- The lead is set at launch. If the hook says it does not match, tell the user to run `ccm extra-high -c`; avoid
  `/model` (it saves machine-wide).
- Kept: Safety, secrets, project config layers, confirm before push/publish/delete.
- Subscription usage only: never fast mode, never usage-credit features; at a usage limit, wait for the reset.

Applies to this session only.
