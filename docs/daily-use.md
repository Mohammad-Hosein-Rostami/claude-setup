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
- The main session is the boss: it routes the work, asks you what only you can decide and lands branches; it does no work
  itself. It starts four main agents, at most 3 of each at once:
  - `lex` (Opus, high; the boss raises it to `effort: "xhigh"` for a hard design or an unclear need, and to `effort: "max"`
    only when a wrong choice is costly to undo) clarifies, researches, compares, designs and plans, and writes the acceptance
    lines. It asks you its questions at the start of a job. Work on locks, concurrency, security or data loss gets a short
    state design from it first, even when the build looks clear. Its helpers take the simple parts: `lex-scout` (code and doc
    lookups, maps of an area) and `lex-web` (web research with sources).
  - `dev` writes code, config and fixes in its own worktree and runs no tests. It splits the job into parts, each owning its
    files (parts that share a file run one after another), may write any part itself and reads every helper's diff before
    taking it. Its helpers: `dev-part` (one part; Sonnet by default, Opus or xhigh for an important, risky or hard part),
    `dev-ui` (screens, components, forms), `dev-pixel` (Figma to code; its final gate is `pixel-qa`), `dev-debug` (hard bugs,
    root cause), `dev-docs` (the docs and user-facing text, written while the code is built), `dev-run` (installs, long logs,
    returned as a short summary) and `lex-scout`.
  - `tess` runs the quality checks in the background, by the table "Which tess work a change gets" in the `qa-plan` skill
    (`home/CLAUDE.md`, "Quality checks", sums it up): a risky change
    (security, data, money, concurrency, gate such as the setup's own hooks, large) waits for tess before it lands; other code changes get
    one background check at the end of the job; docs and text only get none; and anything you ask for runs at once. When a
    feature that uses Claude first works, dev names a `smoke:` line (the command and what it should show); tess runs it 1 to 3
    times with real Claude and records each try, and nothing waits for it. tess (Opus)
    plans and judges; its helpers do the work. A small change (risk none, under about 300 changed lines) gets 2 or 3 of them,
    and a review runs at effort `xhigh` only for data, money, concurrency or security work (a review of docs or text only runs
    on Sonnet). The helpers: `tess-run` (the runs, the full suite once per tree), `tess-edge`
    (edge cases), `tess-simple` (needless complexity), `tess-review` (reviews the code against lex's spec) and `tess-write`
    (writes the missing tests in its own worktree, one per area; tess then proves each one can fail).
  - `max` (the ship agent; Opus, high) starts rarely: when you call it, or after a job's last land when lex's plan names a
    `ship:` target or you asked for a release, deploy or showcase. It prepares everything (release notes, deploy and rollback
    plans, the exact commands) and never pushes, publishes, deploys or writes to production on its own; it runs one of those
    only on an `owner-command:` line, from your own words in chat.
- Only the boss starts `lex`, `dev`, `tess` and `max`. An agent that needs one asks the boss with a `needs:` line (by message
  while it runs in the background, else in its report); the boss starts it, keeps track of who is on what and sends the result
  back.
- After 3 rounds of fix and review on one area, the boss stops patching and sends the area to `lex` for a redesign; on the
  redesigned tasks only a regression that a fix caused blocks landing.
- Helpers are not counted. Two lanes or helpers never change the same file at once. Technical choices are made and stated in one line; your decisions are asked.
- Landing is one script call, not an agent: the `land` script (`home/tools/land`) rebases the branch, fast-forwards it with
  `git merge --ff-only` and removes the landed branch and worktree. `--test "<command>"` runs a test on the rebased tip first.
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
  over 3 minutes goes to the background with its `timeout` set (at most 2 h).
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
- Agents never push unless you ask.

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
- Because the repo is live in every session, edit hooks and tools in a git worktree (`scripts/lane-new.sh <name>` makes one on `lane/<name>` and installs the tool dependencies); when the suite is green, rebase onto main and
  fast-forward (`git merge --ff-only`).

## Another machine
`git pull`, then `scripts/install.sh` (Windows PowerShell:
`powershell -ExecutionPolicy Bypass -File scripts\install.ps1`). To check the machine, ask `tess` for a setup check.

On Windows without Developer Mode the installer copies files instead of linking them, so they do not follow later
edits: re-run the installer after every pull. Not yet tested on Windows: `install.ps1` has not been run there, and the
tests have not been run there (`tests/pin-home.mjs` and the warm-exec fakes assume POSIX scripts).

## Where things are
- Reports from agents and audits: `~/Desktop/claude-setup-reports/`.
- What exists: [catalog.md](catalog.md), generated by install (`node scripts/catalog.mjs write` rebuilds it). Problems: [troubleshooting.md](troubleshooting.md).
