# Mode: ultra-high (lead Fable 5.2 at max; full speed, never wasted)

Same quality gates as every mode (see CLAUDE.md). Unlike normal/medium/high, this mode also sets the lead (Fable 5.2 at effort max, set by `ccm ultra-high`) and sends important jobs to agents on Opus at max.

- Opus-max escalation, per Agent call `model: "opus", effort: "max"`, for jobs that need it:
  - architecture and planning (`architect`); hard or failed-once bugs (`deep-debugger`);
  - risky or final reviews (`reviewer`) and security audits (`security-auditor`);
  - risky or cross-module code (`implementer`); important decisions.
- Everything else keeps its pinned model: Sonnet workers, Haiku for mechanical work. No duplicate agents.
- Parallelism, workflows and reports as in high: wide fan-out in one message; Claude starts a workflow itself for
  substantive multi-part tasks, no size limit. Choosing `ccm ultra-high` or `/mode ultra-high` is the user's standing
  request for this.
- The lead is set at launch. If the hook says it does not match, tell the user to run `ccm ultra-high -c`; avoid
  `/model` (it saves machine-wide).
- Fable is included only on Max/Ultra/Team Premium plans, up to 50% of the weekly limit; beyond that (or on Pro) it
  bills usage credits. Never continue on credits: at Fable's cap, stop and tell the user to run `ccm extra-high -c`.
- Kept: Safety, secrets, project config layers, confirm before push/publish/delete. Ask only for the user's decisions.
- Subscription usage only: never fast mode, never usage-credit features; at a usage limit, wait for the reset.

Applies to this session only.
