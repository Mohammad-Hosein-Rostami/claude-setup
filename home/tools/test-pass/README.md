# test-pass

Remembers which git tree passed which test command, so landing a branch reruns the full suite only when no run already
passed on that exact tree. Node 22, no dependencies (it uses `git`).

Run: `node ~/.claude/tools/test-pass/test-pass.mjs <command>`

| Command | What it does |
| ------- | ------------ |
| `run [--repo <dir>] [--suite] [--quiet] [-- <cmd...>]` | Runs `<cmd>` (no shell) in the repo and exits with its code. `--quiet` prints one line when it passes, the last 60 lines of output when it fails. With `--suite` and no command it runs the repo's declared full-suite command through the shell; with `--suite` and a command, that command must be the declared one (else exit 2). |
| `check <sha> [--repo <dir>] [--suite]` | Exit 0 when a PASS is recorded for the tree of `<sha>`, 1 when none, 2 for a usage error. `--suite` counts only full-suite PASSes. |
| `suite show [--repo <dir>]` | Prints the declared full-suite command (exit 1 when the repo declares none). |

## The declared full-suite command

The repo declares it, the tool never stores its own: the `test` script of the root `package.json`, else a `CLAUDE.md` bullet
such as ``- Tests: `node --test tests/*.test.mjs` ``. There is no override; changing the command is a commit to the repo. A
`--suite` record stores that exact command text and `hasPass(..., { suite: true })` accepts only a record with the same text, so
a run of related tests (`run -- <cmd>`) never stands in for the suite.

## When a PASS is recorded

Only when all three hold: the command exits 0; the tree had no tracked change (staged or not) and no untracked file that git
does not ignore when the command started; HEAD's tree is the same after the run. A run that fails these still exits with the
command's code and says on stderr why nothing was recorded.

The record is `{tree, sha, cmd, suite, at, ms}`. It is keyed by the tree (the hash of the files), so a rebase that changes no
file keeps its PASS, and by the clone (hash of the real git common dir), so every worktree of a clone shares the records.

## State

`~/.claude/state/test-pass/<16 hex>.jsonl`, one JSON row per line, the newest 200 kept. The folder is 0700 and the file 0600. A
link, folder or foreign-owned file at that name makes the store unusable: nothing is read or written (a missing record only
costs a rerun, never a false PASS). Two runs finishing at the same moment may drop one row for the same reason.

## Proof records

`record`, `mutants` and `proof` keep what a test run at a commit really did, so a hand-over rests on a record, never on a model's words.

| Command | What it does |
| ------- | ------------ |
| `record [--repo <dir>] [--role <role>] [--tests <ids>] [--report <file>] [--target <name>] -- <cmd...>` | Runs `<cmd>` (no shell) on a clean tree, prints its last 60 lines, reads the counts from node --test's summary (TAP `# pass N` or spec `ℹ pass N`) or from `--report` (the same, or a JUnit XML file), and stores `{sha, tree, cmd, role, tests, selected, passed, failed, skipped, exit, verdict}`, pass or fail. Roles: `repro` (a bug's failing-first test, recorded red before the fix and green after), `acceptance`, `keep-green` (default), `suite`, `target` (a run on the real target). Exits with the command's code; 2 for a dirty tree. |
| `mutants [--repo <dir>] --patch <file>... [--timeout-ms <n>] -- <cmd...>` | Copies the working tree (without `.git`) to a temp folder, checks the keep-green command passes there, then applies each patch, runs the command and reverts: `mutants: <killed>/<n>` from the exit codes (a patch that does not apply counts as not killed; a timeout as killed). Stores the count as a `mutants` record of HEAD. |
| `proof <sha> [--repo <dir>] [--handover <file>] [--real-target]` | Exit 0 when the records of `<sha>` back the hand-over, 1 with one `refused:` line each when: no record for exactly this sha; 0 tests selected or unreadable counts; a stored verdict its exit code contradicts; a skip counted as a pass; a repro not red at an earlier commit; "all pass" over a failing record; a typed test or `mutants:` count no record holds; a flow that needs the real target (`--real-target`, or a `real target: needed` line) with no passing `target` run. The last line is the `verdict:` line a runner copies. |

PASS needs exit 0, readable counts, at least one test passed and none failed. Records sit beside the PASS store (same folder and file rules, newest 200).

## Use from code

`import { hasPass, declaredSuite } from '.../test-pass/test-pass.mjs'`: `hasPass(repoDir, rev, { suite?, cmd?, env? })` is true
when a PASS is recorded for the tree of `rev`; with `suite: true` the command must equal `cmd` (default: `declaredSuite(repoDir)`);
`env.HOME` moves the state folder (tests). Files: `test-pass.mjs` (CLI), `lib/store.mjs` (records, declared command).
