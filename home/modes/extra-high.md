# Mode: extra-high (lead Opus 5.5 at max; full speed, never wasted)

Same quality gates as every mode (see the lead rules and CLAUDE.md). Unlike normal/medium/high, this mode also sets the lead (Opus 5.5 at effort max, set by `ccm extra-high`) and sends important jobs to agents on Opus at max.

- Opus-max escalation, per Agent call `model: "opus", effort: "max"`, for jobs that need it:
  - architecture and planning (`architect`); hard or failed-once bugs (`deep-debugger`);
  - risky or cross-module code (`implementer`); important decisions.
- Risky or final reviews and security audits run on Opus max in every mode (lead rules). Everything else keeps its pinned model: Sonnet workers, Haiku for mechanical work. No duplicate agents.
- Lane budget: up to 6 agents at once (as high) (writing agents; reads, reviews and verifiers are not capped by the mode). Parallelism and report brevity as in high (short final answer, detail in files).
- The lead is set at launch. If the hook says it does not match, tell the user to run `ccm extra-high -c`; avoid
  `/model` (it saves machine-wide).
- Subscription usage only: never fast mode, never usage-credit features; at a usage limit, wait for the reset.

Applies to this session only.
