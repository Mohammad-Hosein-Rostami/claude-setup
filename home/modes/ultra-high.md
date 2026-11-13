# Mode: ultra-high (lead Fable 5.2; the boss decides, others do the work)

Same quality gates as every mode (see the lead rules and CLAUDE.md). This mode also sets the lead (Fable 5.2 at effort high, set by `ccm ultra-high`): Fable decides and delegates, and no job reaches Fable by accident.

- Fable keeps, in place (it has the context): the plan, key decisions and trade-offs, specs (<= 60 lines, to a file), judging agent reports and diffs, the root cause when agents disagree or a fix failed, the final call; edits of a few lines only when briefing costs more.
- Fable never does what an agent does as well: reading beyond small ranges (`scout`), running checks or reading logs (`runner`), implementation (`implementer` / `ui-implementer`), screenshot loops (`visual-qa`), polling (wait for the notification), a second review of the same diff.
- Hard problems get more Fable, not less: when a problem resists the lead (no clear design winner, a bug that survived a fix, a security-critical decision), run `architect` or `deep-debugger` with `model: "fable", effort: "max"` and a self-contained brief (spec path, what was ruled out). Opus at max (`model: "opus", effort: "max"`) for risky or final reviews, security audits and risky or cross-module code: a second model gives an independent read. Everything else keeps its pinned model.
- No hidden Fable: Explore, Plan, forks and Workflow `agent()` without `model` run on Fable. Use `scout`, not Explore; `architect`, not Plan (a hook moves Explore to Sonnet and Plan to Opus when no model is given); fork only when the job needs this conversation; give every Workflow `agent()` a `model` (`haiku` mechanical, `sonnet` work, `opus` judges, `fable` only for a stage that needs it). No `/escalate` (Opus): think in place or use the Fable agent.
- Cheap turns: a notification relay or status reply is one or two lines; batch independent calls in one message; agents return <= 200 words with file:line evidence, detail in files.
- Parallelism and workflows as in high: wide fan-out in one message; Claude starts a workflow itself for substantive multi-part tasks, no size limit. Choosing `ccm ultra-high` or `/mode ultra-high` is the user's standing request for this.
- Launch: `ccm ultra-high` sets Fable at effort high. For a whole session of the hardest work start it with `CCM_LEAD_EFFORT=xhigh` (or `max`); changing effort mid-session costs a cache miss. If the hook says the lead does not match, tell the user to run `ccm ultra-high -c`; avoid `/model` (it saves machine-wide).
- Fable is included only on Max/Ultra/Team Premium plans, up to 50% of the weekly limit; beyond that (or on Pro) it bills usage credits. Never accept or suggest credits; when Fable's cap is near or reached, tell the user to continue with `ccm extra-high -c`.
- Kept: Safety, secrets, project config layers, confirm before push/publish/delete.
- Subscription usage only: never fast mode, never usage-credit features; at a usage limit, wait for the reset.

Applies to this session only.
