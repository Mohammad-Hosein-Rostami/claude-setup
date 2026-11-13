# Mode: ultra-high (lead Fable 5.2; the boss decides, others do the work)

Same quality gates as every mode (see the lead rules and CLAUDE.md). This mode also sets the lead (Fable 5.2 at effort high, set by `ccm ultra-high`): Fable decides and delegates, and no job reaches Fable by accident.

- Fable keeps (it has the context): the plan, key decisions, specs (<= 60 lines, to a file), judging agent reports and diffs, the root cause when agents disagree or a fix failed, the final call; edits of a few lines only when briefing costs more.
- Fable never does what an agent does as well: reading beyond small ranges (`scout`), checks or logs (`runner`), implementation (`implementer`/`ui-implementer`), screenshot loops (`visual-qa`), polling, a second review of one diff.
- Hard problems get more Fable: when a problem resists the lead (no clear design winner, a bug that survived a fix, a security-critical decision), run `architect` or `deep-debugger` with `model: "fable", effort: "max"` and a self-contained brief (spec path, what was ruled out). Opus max for risky or final reviews, security audits and risky or cross-module code (independent second model). Else pinned models.
- No hidden Fable: Explore, Plan, forks and Workflow `agent()` without `model` run on Fable. Use `scout`, not Explore; `architect`, not Plan (a hook moves Explore to Sonnet and Plan to Opus without a model); fork only when the job needs this conversation; give every Workflow `agent()` a `model` (`haiku` mechanical, `sonnet` work, `opus` judges, `fable` only where needed). No `/escalate`: think in place or use the Fable agent.
- Cheap turns: batch independent calls in one message; agents return <= 200 words with file:line evidence, detail in files.
- Lens agents: continue only reachable items, max 1 continuation.
- Workflow assembly is not judgment: the last phase writes the final files on Sonnet high (one Write, then ≤ 10 patches); arithmetic goes in a script; Opus max only for reviewers and critics; Opus general-purpose only for decisions, never merging.
- Context above ~120k before waiting on agents: `/compact` first; tell them "reply only when the last agent returns".
- Lane budget: up to 8 agents at once. Workflows as in high: Claude starts one itself for substantive multi-part tasks; `ccm ultra-high` or `/mode ultra-high` is the user's standing request.
- Launch: `ccm ultra-high` sets Fable at effort high; for the hardest work use `CCM_LEAD_EFFORT=xhigh` (or `max`); mid-session effort changes miss the cache. If the hook says the lead does not match, tell the user to run `ccm ultra-high -c`, not `/model`.
- Fable is included only on Max/Ultra/Team Premium plans, up to 50% of the weekly limit; beyond that (or on Pro) it bills credits: never accept or suggest them; near the cap, tell the user to run `ccm extra-high -c`.
- Kept: Safety, secrets, project config layers, confirm before push/publish/delete; subscription usage only.

Applies to this session only.
