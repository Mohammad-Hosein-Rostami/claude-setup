# Daily use

How to work with this setup day to day. Editing the repo itself is in [usage.md](usage.md); install is in
[setup.md](setup.md); every file is listed in [catalog.md](catalog.md).

## Start
Start a session with `claude --model <m> --effort <e>`, for example `claude --model opus --effort high` (the usual boss);
add `-c` to continue this folder's last conversation. With several accounts, run `claude-as <name>` in the terminal first.
Keep the model all session (a model switch rebuilds the cache); raise the effort for one hard turn with `/effort`.
Keep extra usage off in claude.ai so nothing can bill credits.

## A normal task
- One task per session. For an unrelated next task, `/clear` or start a new session first.
- The main session is the boss: it routes the work, asks you what only you can decide and lands branches; it does no work
  itself. It starts three main agents, at most 3 at once:
  - `lex` clarifies, researches, compares, designs and plans, and writes the acceptance lines. It asks you its questions at
    the start of a job. Its helpers: `lex-scout` (code and doc lookups) and `lex-web` (web research with sources).
  - `dev` writes code, config and fixes in its own worktree. Its helpers: `dev-ui` (screens, components, forms), `dev-pixel`
    (Figma to code; its final gate is `pixel-qa`), `dev-debug` (hard bugs, root cause) and `dev-run` (installs, builds, long
    logs, returned as a short summary).
  - `tess` runs the quality checks in the background, by the table under "Quality checks" in `home/CLAUDE.md`: a risky change
    (security, data, money, concurrency, the setup's guards, very large) waits for tess before it lands; other code changes get
    one background check at the end of the job; docs and text only get none; and anything you ask for runs at once. Its helpers:
    `tess-review` (reviews the code against lex's spec) and `tess-write` (writes the missing tests in its own worktree; tess then
    proves each one can fail).
- Only the boss starts `lex`, `dev` and `tess`. An agent that needs one asks the boss with a `needs:` line (by message while it
  runs in the background, else in its report); the boss starts it, keeps track of who is on what and sends the result back.
- Helpers are not counted in the 6. Technical choices are made and stated in one line; your decisions are asked.
- Landing is one script call, not an agent: the `land` script (`home/tools/land`) rebases the branch, fast-forwards it with
  `git merge --ff-only` and removes the landed branch and worktree. A machine sync, where your setup has one, brings your
  other machines along (`docs/setup.md`, "Sync the machines").
- UI work is checked as closely as the change needs, by the check plan (`node ~/.claude/tools/ui-proof/ui-proof.mjs plan`, rules
  in `home/standards/ui-checks.md`): nobody labels the work; the request, the diff and the screens it reaches decide. A docs page,
  tests or config need no UI proof (none); a dependency bump or a "no visual change" request needs identical renders before and
  after (same); logic, text or look on a screen with no design needs before and after renders with no new problem (render); a new
  screen or state takes the `dev-pixel` compare loop and the `pixel-qa` final gate (visual). A design word in the request, or a
  look change on a screen with a Figma frame, takes the full pixel-perfect path, unchanged: `figma-pixel-perfect`, `ui-check run`
  rounds until every state passes, then the `pixel-qa` final gate on the tree that lands (pixel). `ui-quality-pass` runs before
  done at every depth but none (under same as a review that lists `follow-up:` lines).
- The guards stay on: the Bash guard, gitleaks and `node --check` of hook files at commit, and the `git-tidy` check at session start.
- While agents run you can keep talking to the boss: it answers and asks without stopping the agents. A command that may run
  over 3 minutes goes to the background with its `timeout` set (at most 2 h).
- The final answer says what changed and what was not run. No recap of the process.

## Questions
- `lex` asks at the start of a job. Any other agent that needs you stops and returns a `questions:` block: each question in
  plain words, what it blocks, 2-4 options with the recommended one first, and a preview when the choice is a layout.
- The boss asks them as popups in one batch and sends your answers back to the agent.
- With no answer in time, a small, reversible choice takes the recommended option; a big or deleting one waits for you.

## Long or unattended runs
- Run long or unattended sessions in a plain terminal app (or tmux), not an editor's built-in terminal: closing or
  reloading the editor window ends every session in it. Resume with `claude --model <m> --effort <e> -c`.
- A question (AskUserQuestion) gets one timed dialog per question, one after the other (hook `permission-timed-allow.mjs`; the
  dialog shows the question, its options with the recommended one first and what happens with no answer), each with its own
  wait: with no answer in 2 minutes (`CLAUDE_QUESTION_TIMEOUT_S`, 120 s; from 5 questions on less, 114 s for 5, so all popups
  end before the terminal question auto-continues after 10 minutes) or on "Use recommended" it takes that question's
  "(Recommended)" option, else its first. An answer taken on timeout arrives with the note "No answer in 2 min: this option
  was taken by default, not chosen by the owner (UNCONFIRMED)"; a click on "Use recommended" arrives with none. Enter on
  question 1 means "Use recommended"; on questions 2..N Enter means "Answer in terminal", so a keypress meant for the terminal
  never answers. "Answer in terminal" (or Esc) opens the normal question; answering it there, or turning it down there, closes
  the open dialog.
  With no GUI (ssh, no display) the terminal question stays and auto-continues after 10 minutes (`askUserQuestionTimeout`
  "10m"; the CLI also takes one or five minutes, or never), a timer that does not count down while that terminal window is
  focused and starts again after any keypress; it never starts in a background session, in screen reader mode or while the
  session is connected to Remote Control (those questions wait for an answer). The recommended option is chosen to be safe with nobody there, and each default taken
  is logged. For a big or deleting change the recommended option is "wait for the owner", so a timeout pauses only that part
  (RC10, skill `ask-owner`).
- Guard dialogs (`git push`, publish, `rm -rf` outside the project or of a whole folder such as `rm -rf *`, prod-host writes) default to
  Allow and go ahead after 2 min (`CLAUDE_ASK_TIMEOUT_S`). A literal secret in a command (a test password) asks nothing; the
  guard log names its kind, never the value, and gitleaks still checks commits (owner decision R22-G1).
  Every Claude Code permission prompt (any tool, MCP tools, Agent, plan approval, protected files, any mode, background
  agents and `claude -p`) gets the same dialog and goes ahead after 2 min (`CLAUDE_PERMISSION_TIMEOUT_S`); the dialog
  shows the guard's reason when the guard asked. Questions get their own dialog (above).
  Over ssh or with no display there is no dialog: Claude Code's own prompt, or its deny in a `-p` run. A click on Deny blocks
  for good. A command Claude can rewrite (a `$VAR` command word, `rm`/`push` inside `$(...)` or a heredoc, a literal
  secret) is first sent back to Claude once with the fix, so no dialog waits; the message also names what will still
  ask after the rewrite (a push, an `rm` outside the project ...), and sent again unchanged, it gets the dialog. A
  secret sent back this way shows you no dialog, so Claude names its kind in the final report: rotate it if needed.
  A quality rule (a hand-edited lockfile, a `git merge` or plain `git pull` that can create a merge commit, a wait by sleeping: a
  `sleep` loop or one long `sleep`) is advice, not a dialog: Claude gets the fix once (let the package manager write the lockfile;
  rebase or `--ff-only`; run the long command in the background with a `timeout`), and the same
  command sent again runs. Every ask and its outcome is in `~/.claude/logs/guard.jsonl`.
- `tess` always runs in the background and reports to the boss. Only the landing of a risky change waits for its
  `landing: ok`; when it finds a real bug in work that already landed, the boss starts the fix at once and tells you in one line.
- A job of several long steps that must survive crashes, reboots and usage limits with nobody watching: `long-run`
  (`node ~/.claude/tools/long-run/long-run.mjs`). Each step is one `claude -p` boss session with its own team; a crash, limit,
  pause or takeover continues the same session. Start it from a terminal (`check job.json`, then `start job.json`) or ask a
  Claude session in plain words (the `long-run` skill writes the job, shows the plan and starts only on your typed yes, then
  reports each event in one line). Then `status`, `log <run> <step> --tail 20`, `watch`, `pause` / `stop <run> [step]`,
  `takeover <run> <step>` (three lines to paste: you are in that session), `resume <run>` (`--answer "..."` for a question),
  `tell <run> <step> "..."` (reaches a running step at its next tool end) and `events --follow`. Each boss start costs about
  35k new cache tokens, so give one boss many small tasks and use parallel steps only for a few big ones. Details, including
  how this parallel compares with Claude Code's own: `home/tools/long-run/README.md`.
- To bring your other machines along after the last landing, run the machine sync on the machine you landed on, in the repo
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
- Agents commit on their own branch; the boss lands each branch with the `land` script (rebase onto main, then
  `git merge --ff-only`), one at a time, which then removes the landed branch and worktree.
- Ask "clean up the git tree" and the `git-linear-history` skill loads; it backs up first and proves the tree is unchanged.
- The two commands: `node ~/.claude/tools/git-tidy/git-tidy.mjs check` (what is left to clean) and `... prune --apply`.
- Pushes and remote branch deletes still ask you.

## Keeping context
- Auto-compaction runs at a 400000-token window (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`); the status line shows the
  context size. Run `/compact` at a natural seam, not mid-step.
- Phase change, repeated compactions or `/clear`: run the `handoff` skill, then `/clear` and say
  "continue from HANDOFF.md".
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
- Because the repo is live in every session, edit hooks and tools in a git worktree (`scripts/lane-new.sh <name>` makes one on `lane/<name>` and installs the tool dependencies); when the suite is green, rebase onto main and
  fast-forward (`git merge --ff-only`).

## Another machine
`git pull`, then `scripts/install.sh` (Windows PowerShell:
`powershell -ExecutionPolicy Bypass -File scripts\install.ps1`). Run `scripts/doctor.sh` to check: it prints one summary line
(`doctor (<machine>, Claude Code <version>): 1 FAIL, 1 WARN, 38 ok`), then only the lines that need a fix; `--all` prints every line.

On Windows without Developer Mode the installer copies files instead of linking them, so they do not follow later
edits: re-run the installer after every pull. Not yet tested on Windows: `install.ps1` has not been run there, the
guard tests have not been run there (`tests/pin-home.mjs` and the warm-exec fakes assume POSIX scripts), and
`doctor.sh` needs Git Bash and `jq` (there is no PowerShell doctor).

## Where things are
- Reports from agents and audits: `~/Desktop/claude-setup-reports/`.
- Guard log: `~/.claude/logs/guard.jsonl`.
- What exists: [catalog.md](catalog.md). Problems: [troubleshooting.md](troubleshooting.md).
