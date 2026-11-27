# Daily use

How to work with this setup day to day. Editing the repo itself is in [usage.md](usage.md); install is in
[setup.md](setup.md); every file is listed in [catalog.md](catalog.md), which install generates.

## Start
Start a session with `claude --model <m> --effort <e>`, for example `claude --model opus --effort high` (the usual boss);
add `-c` to continue this folder's last conversation. With several accounts, run `claude-as <name>` in the terminal first.
Keep the model all session (a model switch rebuilds the cache); raise the effort for one hard turn with `/effort`.
Keep extra usage off in claude.ai so nothing can bill credits.

## A normal task
- One task per session. For an unrelated next task, `/clear` or start a new session first.
- The main session is the boss: it hands out the pieces of lex's plan, starts the agents, lands each piece, checks main and
  asks you what only you can decide; it plans and builds nothing itself. It starts four main agents, at most 3 of each at
  once:
  - `lex` (Opus, high; the boss raises it to `effort: "xhigh"` for a hard design or an unclear need, and to `effort: "max"`
    only when a wrong choice is costly to undo) clarifies, researches, compares, designs and plans, writes the acceptance
    lines and splits the plan into small pieces (`<plan>.pieces.json`: each piece's feature, files, order and risk). It works
    only for the boss and asks you its questions at the start of a job. Work on locks, concurrency, security or data loss gets
    a short state design from it first, even when the build looks clear. Its helpers take the simple parts: `lex-scout` (code
    and doc lookups, maps of an area) and `lex-web` (web research with sources).
  - `dev` builds one small piece in the lane the boss claimed for it and runs no tests: before it edits, it reads every
    acceptance line, every user of what it changes and each input's states, and before it reports, it reviews its own diff
    against each acceptance line. It splits the piece into parts, each owning its files (parts that share a file run one after
    another), may write any part itself and reads every helper's diff before taking it. Its helpers: `dev-part` (one part;
    Sonnet by default, Opus or xhigh for an important, risky or hard part), `dev-ui` (screens, components, forms), `dev-pixel`
    (Figma to code; its final gate is `pixel-qa`), `dev-debug` (hard bugs, root cause), `dev-docs` (the docs and user-facing
    text, written while the code is built), `dev-run` (installs, long logs, returned as a short summary) and `lex-scout`.
  - `tess` runs the quality checks in the background, only on main and one feature at a time, by the table "Which tess work a
    change gets" in the `qa-plan` skill (`home/CLAUDE.md`, "Quality checks", sums it up). By default tess does only a quick
    look: the tests the change touched, a type or syntax check, and one read of the diff against the brief and its
    acceptance lines. A risky change (security, data, money, concurrency, gate such as the setup's own hooks, large) lands,
    then gets that quick look on main at once, the boss tells you its risk in one line, and no new piece touches its files
    until tess returns; other code changes get it in the next tess round; docs and text only get none. The heavy checks
    (`full`: the whole suite, edge cases, a deep review, new tests, long checks) run only when you ask for them in chat, and
    anything you ask for runs at once. When a feature that uses Claude first works, dev names a `smoke:` line (the
    command and what it should show); tess runs it 1 to 3 times with real Claude and records each try, and nothing waits for
    it. tess (Opus) plans and judges; its helpers do the work. The quick look uses one of them (`tess-run`); `full` uses
    more, and a review runs at effort `xhigh` only for data, money, concurrency or security work (a review of docs or text
    only runs on Sonnet). The helpers: `tess-run` (the runs, the full suite once per tree), `tess-edge`
    (edge cases), `tess-simple` (needless complexity), `tess-review` (reviews the code against lex's spec) and `tess-write`
    (writes the missing tests in its own worktree, one per area; tess then proves each one can fail).
  - `max` (the ship agent; Opus, high) starts rarely: when you call it, or after a job's last land when lex's plan names a
    `ship:` target or you asked for a release, deploy or showcase. It prepares everything (release notes, deploy and rollback
    plans, the exact commands) and never pushes, publishes, deploys or writes to production on its own; it runs one of those
    only on an `owner-command:` line, from your own words in chat.
- Only the boss starts `lex`, `dev`, `tess` and `max`. An agent that needs one asks the boss with a `needs:` line (by message
  while it runs in the background, else in its report); the boss starts it, keeps track of who is on what and sends the result
  back. A `needs: lex` always goes to the boss, which decides whether and when to wake lex.
- The boss works in rounds; each land frees a slot, which it fills at once. The base is the branch checked out in the
  main checkout (main, develop or a feature branch); no command names it. Switching it leaves open lanes on their old base:
  land them after switching back. The tools print every step, so the boss writes no claim, command or brief by hand:
  1. After every agent report or finished background step, after a compaction and when you ask how things stand, it runs
     `node ~/.claude/tools/board/board.mjs tick --repo <main checkout>` (a new plan once with `--plan <pieces.json>`; the
     tick remembers every open plan of the repository). The tick shows the base (`base <name>`), the lanes in flight, each
     job's queue and features, the held files, and ends with `next:` and numbered `do` lines, which replace every earlier one.
  2. It runs each `do` line in order, as printed, and reads each output whole (never cut with `head`, `tail` or `grep`):
     - `land`: only when dev's report says `done`, or `partial` with `safe to land: yes` (its open lines go back in the queue
       as a new piece); never a `blocked` one. The `land` script lands one branch at a time and then prints the next tick:
       the boss goes on with that tick's `do` lines.
     - `start dev` and `start tess`: `board start` claims the pool lane (for tess a snapshot of the base, and its mark) and
       prints the description and the brief; the boss starts the agent with both, whole. No agent makes its own folder.
     - `resume`: a `completed` notice that only says the agent still waits means it stopped: the boss resumes it by
       SendMessage with the helper results that reached the boss.
     - `release`: a tess snapshot still locked after an hour with no tess on it.
     - `land <test branch>`: a passing `test/<topic>` branch from tess's `land: test/<topic>` line, landed like a dev report.
     - `sync`: the machine sync, run in the background; `sync failed` is told to you once and becomes a `Fix:` piece.
  3. tess is due when 3 features have landed unchecked or the job's last piece has landed, and at once for a risky one. It
     tests its feature in its snapshot, never in the main folder, which keeps moving as pieces land. When you asked for
     `full`, only one of them runs the full suite (`suite: yes`); the others reuse its result. tess answers `main: ok` or
     `main: must-fix <n>`, records it with the brief's `done:` command and frees its snapshot with `release:`. The boss
     re-checks a must-fix on the newest main, then makes it the next piece (`Fix:`), which lands on its repro's
     `test/<topic>` branch when it has one.
  4. A report's `questions:` go to you (skill `ask-owner`); a `needs:` line starts that agent with the description
     `<type> for <asker id7>: <task>`, so the board keeps who asked after a compaction. A failed step (a land or a claim
     refused, a sync that failed) is told to you once and becomes a `Fix:` piece.

  The tick's `agents` and `job` lines answer "where are we" and "how long": the agents running and for how long, each job's
  pieces landed, in lanes and waiting, its features checked, and its pace measured from the land ledger
  (`pace unknown (fewer than 2 lands)`; never a guess).
- The briefs the tools do not print:
  - `lex`: the first line `analysis: <question>` or `plan: <request>`; then `repo:`, `out: <abs plan path>`, `open plans:` (the
    pieces.json paths of the tick's `job` lines), your words quoted, and `codex: yes` only when you asked for Codex.
  - `max`: exactly the fields of its Brief (`home/agents/max.md`): `mode:`, `repo:`, `target:`, `base:`, `spec:`, `tess:`
    (the latest verdict and its sha), `worktree:`, `BASE:`, `BRANCH: ship/<topic>`, and `owner-command:` only from your own
    words in chat. Its folder is a pool claim of `ship/<topic>`
    (`node ~/.claude/tools/git-tidy/git-tidy.mjs lane claim --repo <main checkout> --branch ship/<topic>`).
- After 3 rounds of fix and review on one area, the boss stops patching and sends the area to `lex` for a redesign; on the
  redesigned tasks only a regression that a fix caused counts as a must-fix.
- Helpers are not counted. Two lanes or helpers never change the same file at once. Technical choices are made and stated in one line; your decisions are asked.
- Landing is one script call, not an agent: the `land` script (`home/tools/land`) rebases the branch, fast-forwards it with
  `git merge --ff-only`, deletes the landed branch and keeps its pool folder for the next lane. `--test "<command>"` runs a
  test on the rebased tip first.
  Run the full suite that way when the base and the lane changed the same files; without `--test`, `land` lands after the
  rebase. A rebase conflict is reported first. A machine sync, where your setup has one, brings your
  other machines along (`docs/setup.md`, "Sync the machines").
- UI work is checked as closely as the change needs, by the check plan (`node ~/.claude/tools/ui-proof/ui-proof.mjs plan`, rules
  in `home/standards/ui-checks.md`): nobody labels the work; the request, the diff and the screens it reaches decide. A docs page,
  tests or config need no UI proof (none); a dependency bump or a "no visual change" request needs identical renders before and
  after (same); logic, text or look on a screen with no design needs before and after renders with no new problem (render); a new
  screen or state takes the `dev-pixel` compare loop and the `pixel-qa` final gate (visual). A design word in the request, or a
  look change on a screen with a Figma frame, takes the full pixel-perfect path, unchanged: `figma-pixel-perfect`, `ui-check run`
  rounds until every state passes, then the `pixel-qa` final gate on the tree that lands (pixel). `ui-quality-pass` runs before
  done at every depth but none (under same as a review that lists `follow-up:` lines).
- Agents have full access: commands run with no permission prompt, and the rules stay as instructions. The `git-tidy` check
  at session start names the lanes that are not landed yet.
- While agents run you can keep talking to the boss: it answers and asks without stopping the agents. A command that may run
  over 3 minutes goes to the background with its `timeout` set (at most 2 h). A helper's reply that says it `is waiting on its
  own background work` is not its result: the agent that started it keeps a keep-alive running until it returns.
- The final answer says what changed and what was not run. No recap of the process.

## Questions
- `lex` asks at the start of a job. Any other agent that needs you stops and returns a `questions:` block: each question in
  plain words, what it blocks, 2-4 options with the recommended one first, and a preview when the choice is a layout.
- The boss asks them in one batch in the terminal and sends your answers back to the agent.
- A question with no answer in time: a small, reversible choice takes the recommended option; a big or deleting one waits for
  you. Agents have full access, so there are no permission prompts to answer; `max` still runs an outward step (push,
  publish, deploy) only on an `owner-command:` line.

## Long or unattended runs
- Run long or unattended sessions in a plain terminal app (or tmux), not an editor's built-in terminal: closing or
  reloading the editor window ends every session in it. Resume with `claude --model <m> --effort <e> -c`.
- A question (AskUserQuestion) is Claude Code's own terminal question; there is no popup (it was removed on 2026-11-25: its
  PermissionRequest hook kept Claude Code from waiving the dangerous-rm prompt). Left unanswered it auto-continues after 5
  minutes (`askUserQuestionTimeout` "5m"; the CLI also takes one or ten minutes, or never, but not two), Claude is told
  nobody answered and takes the "(Recommended)" option, marked UNCONFIRMED. The timer does not count down while that
  terminal window is focused and starts again after any keypress; it never starts in a background session, in screen reader mode or while the
  session is connected to Remote Control (those questions wait for an answer). The recommended option is chosen to be safe
  with nobody there. For a big or deleting change the recommended option is "wait for the owner", so a timeout pauses only
  that part (skill `ask-owner`).
- `tess` always runs in the background, on main, and reports to the boss. Nothing waits for it to land; after a risky piece
  lands, no new piece touches its files until tess returns. When it finds a real bug, the boss starts the fix at once and tells
  you in one line.
- A job of several long steps that must survive crashes, reboots and usage limits with nobody watching: `long-run`
  (`node ~/.claude/tools/long-run/long-run.mjs`). Each step is one `claude -p` boss session with its own team; a crash, limit,
  pause or takeover continues the same session. Start it from a terminal (`check job.json`, then `start job.json`) or ask a
  Claude session in plain words (the `long-run` skill writes the job, shows the plan and starts only on your typed yes, then
  reports each event in one line). Then `status`, `log <run> <step> --tail 20`, `watch`, `pause` / `stop <run> [step]`,
  `takeover <run> <step>` (three lines to paste: you are in that session), `resume <run>` (`--answer "..."` for a question),
  `tell <run> <step> "..."` (reaches a running step at its next tool end) and `events --follow`. Each boss start costs about
  35k new cache tokens, so give one boss many small tasks and use parallel steps only for a few big ones. Details, including
  how this parallel compares with Claude Code's own: `home/tools/long-run/README.md`.
- To bring your other machines along after every landing, run the machine sync on the machine you landed on, in the repo
  folder, as `docs/setup.md` ("Sync the machines") gives it; it never pushes.

## What to expect from agents
- Agents get one full brief (acceptance lines, failure cases, defaults) and finish it instead of stopping to ask about
  technical details; each default they took is listed in the report. Only your decisions (scope, money, irreversible,
  credentials) reach you. Expect fewer status messages.
- Before reporting, an agent re-reads its own diff against the spec. A finding you or the boss raise goes back in one message.
- Saying that a fix did not hold ("still wrong", "i told you before", "third time") makes the agent reproduce the exact
  symptom first and check it before it replies.

## Restructuring a repository
Say what to remove or merge ("remove Nx", "merge the apps into one project") and the `repo-restructure` skill loads.
- The agent writes lists of what to delete, keep and propose (it asks before deleting anything you did not name), and
  records a baseline (install, typecheck, lint, tests, build) before the first change.
- Each step is a small commit you can revert alone; files git does not track are never touched without your yes.
- Env files are compared by variable name only, and a final sweep greps hidden folders for leftovers of the old layout.
- You can run the two checks yourself: `node ~/.claude/tools/refs/refs.mjs check .` (paths that point nowhere) and
  `node ~/.claude/tools/env-names/env-names.mjs diff <saved-file> .` (env names added or removed).

## Clean git history
History stays one straight line: no merge commits, no branch merged into another.
- Agents commit on their own branch; the boss lands each branch with the `land` script (rebase onto the base, then
  `git merge --ff-only`), one at a time, which then deletes the landed branch and keeps its pool folder for reuse.
- Ask "clean up the git tree" and the `git-linear-history` skill loads; it backs up first and proves the tree is unchanged.
- The two commands: `node ~/.claude/tools/git-tidy/git-tidy.mjs check` (what is left to clean) and `... prune --apply`.
- Agents never push unless you ask.

## Codex
No session uses Codex unless you ask for it in chat, and then only for a second opinion: Codex reads and gives its view, and
never builds or edits.

Say "use codex" (for example "build this, use codex for a second opinion") and the boss adds a `codex: yes` line to that
job's `lex`, `dev` or `tess` brief. Each of them then starts its own Codex helper once, which runs
`codex exec -m gpt-6.2-sol -c 'model_reasoning_effort="max"' --sandbox read-only` and passes Codex's opinion back unchanged:
- `lex-codex`: after lex has written its plan, a second opinion on the plan.
- `dev-codex`: after dev has committed its work, a review of the diff against the brief; dev fixes what it agrees with.
- `tess-codex`: at the start, a second opinion on tess's test plan; tess adjusts the plan, then runs the checks.

Each agent weighs the opinion and reports what it took and what it rejected, and why (`codex: took <n>, rejected <m>`). If
Codex is not logged in or hits a usage limit, the helper says so in one line and the job goes on without it; nothing retries.

The install also turns on OpenAI's Codex plugin (`codex@openai-codex`), whose commands you start yourself:
- `/codex:review`: a read-only Codex review of your uncommitted changes, or of the branch with `--base main`.
- `/codex:adversarial-review`: a read-only review that challenges the design; add focus text, such as
  `look for race conditions`.
- `/codex:rescue`: hands a task to Codex (investigate a bug, try a fix) through the `codex:codex-rescue` agent.
- `/codex:transfer`: carries the current session over to Codex and prints a `codex resume <id>` command.
- `/codex:status`, `/codex:result` and `/codex:cancel`: follow, read or stop a Codex job started with `--background`.
- `/codex:setup`: checks that Codex is installed and logged in.

Codex use counts against the usage limits of the ChatGPT plan that `codex` is logged in with.

Each machine needs this once: install the `codex` CLI (`npm install -g @openai/codex`), run `codex login` (sign in with
ChatGPT; an API key bills per use, and the helpers refuse it), then run `/codex:setup` in a Claude Code session. The review
gate (a Stop hook that keeps Claude from stopping until a Codex review passes) stays off: do not run
`/codex:setup --enable-review-gate`. Why, and where the plugin keeps that choice: [plugins/README.md](../plugins/README.md).

## Keeping context
- Auto-compaction runs at a 400000-token window (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`); the status line shows the
  context size. Run `/compact` at a natural seam, not mid-step.
- Phase change, repeated compactions or `/clear`: run the `handoff` skill, then `/clear` and say
  "continue from HANDOFF.md". The note pastes the session's agents with their branches and folders from
  `node ~/.claude/tools/board/board.mjs show --refresh`. Run `show [--session <id>] [--refresh] [--json]` yourself any time to
  see the board as plain lines.
- Start a fresh session for an unrelated task, or when context is large and the next step is a new phase.

## Resume after an exit or an account switch
Finished work is on disk, so an exit, a usage-limit stop or a switch of account loses none of it: the branch tips, the
commits on them and any `HANDOFF.md` note.
1. Start the session again: `claude --model <m> --effort <e> -c` (or `claude --resume <session id>`) in the same folder. After a
   switch of account, start it in the same folder with the other account.
2. Say "continue": the boss reads the hand-over note and the branches, continues a stopped agent once with SendMessage, and
   otherwise starts a fresh one with the brief and `git diff <base>...<branch>`.

## At a usage limit
Wait for the subscription reset. Never turn on credits, `/fast`, or `/code-review ultra`. A Fable cap means a new start
on Opus (`claude --model opus --effort high -c`), not credits.

## After changing the setup
- Skills, agents, rules, standards, hooks and tools are live through symlinks: new edits apply at once, and hook scripts
  run fresh on each call.
- Settings, hooks config, CLAUDE.md, agents and plugins are read when a session starts: restart open sessions (`/exit`,
  then `claude -c`).
- `~/.claude/settings.json` is a merged copy: change `settings/base.json`, then re-run `scripts/install.sh`.
- Because the repo is live in every session, edit hooks and tools in a git worktree: a pool lane
  (`node ~/.claude/tools/git-tidy/git-tidy.mjs lane claim --repo <repo> --branch lane/<name>`) or
  `scripts/lane-new.sh <name>`, which makes one on `lane/<name>` and installs the tool dependencies. When the suite is green,
  land it with the `land` script (rebase onto the base, then `git merge --ff-only`).

## Another machine
`git pull`, then `scripts/install.sh` (Windows PowerShell:
`powershell -ExecutionPolicy Bypass -File scripts\install.ps1`). To check the machine, ask `tess` for a setup check.

On Windows without Developer Mode the installer copies files instead of linking them, so they do not follow later
edits: re-run the installer after every pull. Not yet tested on Windows: `install.ps1` has not been run there, and the
tests have not been run there (`tests/pin-home.mjs` and the warm-exec fakes assume POSIX scripts).

## Where things are
- Reports from agents and audits: `~/Desktop/claude-setup-reports/`.
- What exists: [catalog.md](catalog.md), generated by install (`node scripts/catalog.mjs write` rebuilds it). Problems: [troubleshooting.md](troubleshooting.md).
