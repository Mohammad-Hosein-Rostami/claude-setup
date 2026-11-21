# Lead rules (main session only)

## Modes

- `normal` (fewest agents), `medium` (default), `high` (full speed), `extra-high` (lead Opus 5.5 at max), `ultra-high` (lead
  Fable 5.2 at high). `ccm <mode>` at launch, `/mode <m>` switches.
  Risky = auth, data, money, concurrency, security, the last review before push.
- The mode playbook overrides CLAUDE.md token discipline on cost and speed only, never on accuracy.

## Model routing

The session leads on **Opus 5.5 `high`** (normal/medium/high): it thinks, decides, delegates. Agents pin model/effort; unpinned general-purpose gets Sonnet 5.5, Explore and Plan the lead's model. Use `scout`, not Explore; `architect`, not Plan; `implementer`, not general-purpose; give every Workflow `agent()` a `model`: `haiku` mechanical, `sonnet` work, `opus` judges.
Escalate per call via Agent `model`/`effort`: `implementer`/`test-writer` `effort: "high"` for tricky or cross-module code; `reviewer` and `security-auditor` `model: "opus", effort: "max"` for risky changes and the last review before push; `architect`/`deep-debugger` `effort: "xhigh"` for hard problems, a failed try, no clear design winner or a security-critical decision. Never downgrade a pick to save tokens.

- Planning, architecture/API design, trade-offs, hard-bug root cause, judging results, final call: **Opus 5.5 (the session)**; itself, `architect`, `deep-debugger`, `/escalate`.
- Implementation, refactors, tests, normal bug fixes, reviews: **Sonnet 5.5**; `implementer`, `test-writer`, `reviewer`.
- UI implementation: **Sonnet 5.5**; `ui-implementer` (never plain `implementer`).
- Figma match and responsive checks (text only): **Sonnet 5.5**; `visual-qa`, skill `figma-pixel-perfect`.
- Search, many-file reads, tests/lint/build, log triage, summaries, trivial edits: **Haiku 5.5**; `scout`, `runner`, `/quick`.

Rules:

1. Opus writes only a **spec** (decision, files, steps, acceptance checks, ≤ 60 lines)
   to a file for a Sonnet agent, then checks report and diff.
2. Opus keeps strong-model work and few-line edits.
3. 2+ independent lanes: one `build` run, writers within lane budget in worktrees; lane >30 min: `step`.

## Right-size before building

- Plan over ~2 h: a triage (≤ 6 lines): goal and the owner's bar as stated; the work it needs; waste to avoid
  (repeat analysis, needless serial steps, checks re-run on unchanged files, reviews beyond the gates, Opus where Sonnet suffices).
- Gates to risk: `review-tier` names the class and picks the set; one panel per lane at landing; fix rounds review the delta.

## Lead discipline (every mode)

- Reply in the user's language (Persian too).
- Job form: by the job (CLAUDE.md "Inline, agent or workflow"); always a workflow: landing, machine sync.
- No turn without a decision: with work in flight, arm one watch before ending the turn; relays and status 1-2 lines; lanes share a state file.
- Ops to agents: test/lint/build, ssh/git, logs to `runner`; multi-file edits `implementer`; delegate past ~15 Bash calls.
- Land each lane the moment its checks and required review/audit pass via the `land` workflow (rebase, suite PASS at the tip, ff-only, prune); a re-done lane keeps its branch; never update-ref; the base folder holds no edits.
- Spawn brief: one job per agent with all it needs: acceptance checks, failure classes to self-test, defaults for foreseeable questions,
  "finish everything"; a design brief asks for the Reuse inventory, Contract facts and Unconfirmed lists (project `architect` too). Agents return ≤ 300 words, detail in a file; a worker unfinished at ~120 tool calls or the
  2nd compaction returns a status.
- Send all review findings in one message within 5 minutes of the report. A follow-up for an agent idle over 5 minutes that does
  not need its context goes to a fresh agent with the spec and the diff, not a resume.
- Watching: background Bash `node ~/.claude/tools/watch/watch.mjs <session-id> --exit-on-event` replaces re-arming
  Monitor (exits at the first event that needs you; restart it; the ask queue keeps its Monitor).
  Unattended runs first arm one on their own id with `timeout` 7200000 (without it the watch stops after 30 min): `--exit-on-event api-error,stall,limit`.
- Parallel request: first one line on usage-limit risk.
- Multi-day: `STATUS.md` `## Work items`: list the job's rows first; row edits by `status.mjs` only. Estimates: the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` only.
- Digests ≤ 3k chars plus paths; `scout` summarises > ~200 lines; no Read > ~20k.
- Final reply: obey the line cap. After a setup commit, tell the owner to restart the session.
- One update per stage. Final report: a row per owner request (done, how tested, where live, 2-min proof). "Fixed" needs an `evidence:` line. Debug agent only after its row's `add`+`start`. Logs: `status.mjs log`.

## Owner decisions: ask now, keep working

- Owner's call (the Owner decisions line of CLAUDE.md): AskUserQuestion at once. Load `ask-owner` first; at start list decisions, start independent work, ask.
- Job start: all foreseeable owner decisions in one batch beside the steps and lanes; architect "Questions for the owner" before any lane; numbered decisions in `## Owner decisions`, in every brief.
- No answer in 60 s (the dialog takes it; the result notes each such answer `UNCONFIRMED`): take the recommended option, say which; mark it `UNCONFIRMED` in STATUS.md `## Owner decisions` and re-ask it in the next reply.

## Delegating UI work

- Steps: `ui-coverage init` + `MATRIX:`; `ui-implementer` loops `ui-check run`; `visual-qa` gates the rebased landing tree (same matrix/URL/widths), only its PASS counts; paste `result:`/`frames:`.
- Brief: `figma-pixel-perfect` UI brief template, all fields.
- Review its diff by `ui-quality-pass`; re-run browser/responsive checks only for failed, not-run or risky (auth, payments) items.
