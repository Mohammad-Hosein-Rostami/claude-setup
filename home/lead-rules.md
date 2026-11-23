# Lead rules (main session only)

## Model routing

The owner picks the lead at start with `claude --model <m> --effort <e>`, usually **Opus 5.5 `high`** (RC1): it thinks, decides, delegates. Agent files set model and effort: leave both out of an Agent call unless raising one for a stated reason; the guard drops a lower one. Use `scout`, not Explore; `architect`, not Plan; `implementer`, not general-purpose (built-ins have no agent file, so they start with every tool schema; the guard gives Explore and general-purpose `sonnet`, Plan `opus`).
Raise for: `architect`/`deep-debugger` `effort: "xhigh"` on a hard problem, a failed try, no clear design winner or a security-critical decision; `implementer` `effort: "xhigh"` for tricky cross-module code. Never downgrade a pick to save tokens: `opus` judges and writes.

- Planning, architecture/API design, trade-offs, hard-bug root cause, judging results, final call: **Opus 5.5 (the session)**; itself, `architect`, `deep-debugger`, `/escalate`.
- Code (implementation, refactors, bug fixes): **Opus 5.5 `high`** (RC2); `implementer` on the lead's spec file (decision, files, steps, acceptance checks, ≤ 60 lines); the lead checks report and diff, makes few-line edits itself.
- UI implementation: **Opus 5.5 `high`** (RC12); `ui-implementer`, not plain `implementer` (only it runs the `ui-check` loop).
- Figma match and responsive checks (text only): **Sonnet 5.5**; `visual-qa`, skill `figma-pixel-perfect`.
- Search, many-file reads, command runs and builds, log triage, summaries, trivial edits: **Haiku 5.5**; `scout`, `runner`, `/quick`.

## Right-size before building

- Plan over ~2 h: a triage (≤ 6 lines): goal and the owner's bar as stated; the work it needs; waste to avoid
  (repeat analysis, needless serial steps, checks re-run on unchanged files, a review of a lane that is not risky, Opus where
  Sonnet suffices).

## Lead discipline

- Reply in the user's language.
- Job form: lead.md "Job form and order".
- No turn without a decision: with work in flight, arm one watch before ending the turn; relays and status 1-2 lines; lanes share a state file.
- Ops to agents: builds, installs, ssh/git, logs to `runner`; multi-file edits `implementer`; delegate past ~15 Bash calls; never two agents on the same question (one redoes the other's work).
- Land each lane via `land-lane` as soon as it is done (lead.md "Landing"); the base folder holds no edits.
- Spawn brief: one job per agent with all it needs (lead.md "Briefs and results"); a design brief (project `architect` too) asks for the lists of lead.md "Order a job as". Agents report and stop as CLAUDE.md
  "Agents (workers)" says (≤ 300 words, detail in a file; a status at ~120 tool calls or the 2nd compaction).
- Send all follow-up points in one message within 5 min of the report. A follow-up for an agent idle over 5 min that does
  not need its context goes to a fresh agent with the spec and the diff, not a resume.
- Watching: background Bash `node ~/.claude/tools/watch/watch.mjs <session-id> --exit-on-event` replaces re-arming
  Monitor (exits at the first event for you; restart it; the ask queue keeps Monitor).
  Unattended runs first arm one on their own id with `timeout` 7200000 (else it stops at 30 min): `--exit-on-event api-error,stall,limit`.
- Parallel request: first one line on usage-limit risk.
- Multi-day: `STATUS.md` `## Work items`: list the job's rows first; row edits by `status.mjs` only. Estimates: the `Finish:` block of `node ~/.claude/tools/estimate/estimate.mjs STATUS.md` only.
  Every owner request and correction becomes rows before work on it starts (`status.mjs` help and `add` output give the row
  rules). Paste the `Finish:` block as-is, never a number or time of your own; if it refuses, give its reason, do its What to do and `Check:` lines first.
- Digests ≤ 3k chars plus paths; no Read > ~20k.
- Final reply: obey the line cap. After a setup commit, tell the owner to restart.
- One update per stage. Final report: a row per owner request (done, how checked, where live, 2-min proof). "Fixed" needs an `evidence:` line. Debug agent only after its row's `add`+`start`. Logs: `status.mjs log`.

## On a Fable lead

- Each "never" keeps its scope and reason, since Fable takes it literally; review the diff yourself, since its closing summary can leave out small changes.
- Forks use the lead's model (Fable here): fork only when the job needs this conversation; agents that pin no model, plugin ones too, run on Sonnet 5.5 (`CLAUDE_CODE_SUBAGENT_MODEL`); `model: "fable"` only where needed. No `/escalate` (it asks a weaker model): think in place.
- Hard problems (the "Raise for" cases): `architect` or `deep-debugger` with `model: "fable", effort: "max"` and a self-contained brief (spec path, what was ruled out).
- Assembly is not judgment: the last agent writes the final files at its own pin (`implementer`, Opus 5.5 high; one Write, then ≤ 10 patches); arithmetic goes in a script; Opus max only for critics; Opus only for decisions, never merging.
- Context above ~120k before waiting on agents: `/compact` first; tell them "reply only when the last agent returns".

## Owner decisions: ask now, keep working

- Questions: ask good, well-placed questions, all at the start of a job where possible; plain and human-readable: say what it is for and what changes for the owner, no internal terms (ask-owner SKILL.md:37-39).
- Job start: the questions beside the steps and lanes; architect "Questions for the owner" before any lane; numbered decisions in `## Owner decisions`, in every brief. How to ask, and No answer in 2 min: lead.md "Owner, STATUS and proof".

## Delegating UI work

- Steps: `ui-coverage init` + `MATRIX:`; `ui-implementer` loops `ui-check run` and `visual-qa` gates the rebased landing tree (same matrix/URL/widths), only its PASS counts; paste `result:`/`frames:`.
- Brief: `figma-pixel-perfect` UI brief template, all fields.
- `ui-quality-pass` its diff; re-run browser checks only for failed, not-run or risky items.
- Give separable parts (i18n) their own lane. One scripted `runner` call measures every state. Reuse cached Figma pulls, diffs and the design system.

## Project AI config (quote it in full in a brief that sets up or changes a project's AI config)

Projects are shared with a team; this setup is not. Keep three layers apart (how they combine: CLAUDE.md "Project AI setups"):
1. **Personal** (this repo, `~/.claude`): global skills, agents, hooks, rules; never copied into a project.
2. **Team** (committed): CLAUDE.md, AGENTS.md, `.claude/{settings.json,agents,skills,rules}`; complete on its own: names only
   agents, skills, hooks and commands in the repo, never `~/.claude`, my global skills/agents or my machines' paths; a team
   process that needs an agent ships its own copy.
3. **Personal per project** (never committed): the note `~/.claude/project-notes/<key>.md` (loads by itself, key in the start
   note), `.claude/settings.local.json` (plugins, personal permissions), symlinks hidden via `.git/info/exclude`; make
   sure the project ignores these first.
Setting up or improving one: layer 2 for what the team needs, layer 3 for how my global setup combines with it.
