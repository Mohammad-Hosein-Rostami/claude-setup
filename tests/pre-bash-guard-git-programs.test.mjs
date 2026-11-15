// Tests for git's own program names as the Bash guard reads them (home/hooks/lib/command-of.mjs, asGitSubcommand): git runs subcommand
// <sub> as the program `git-<sub>` from its exec path, so a command word whose basename is `git-<sub>` is read as `git <sub> <rest>` and gets
// every git check: force push, --no-verify, core.hooksPath, the merge advice and the commands git runs (lib/git-runs.mjs), also in the
// raw-text backstop (lib/raw-risk.mjs). Programs that only share the prefix (git-lfs, git-tidy, git-cliff) then read as `git lfs ...` and stay
// quiet; the scan after an unknown `git-x` program and the production-host read check keep the asks they had. Command strings are only
// passed to decide(); nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { GIT_UNREADABLE_REASON } from '../home/hooks/lib/git-runs.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: ['db1.example.com'] };
const EXEC_PATH = '/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core'; // `git --exec-path` of the git 2.54 the audit ran
const RM = 'rm -rf ~/x';
const FORCE_PUSH = /^DESTRUCTIVE: force push overwrites remote history/;
const RM_OUTSIDE = /^DESTRUCTIVE: rm -r outside the project/;
const PROD_WRITE = /^ssh may change db1\.example\.com, a production host/;

const reasonOf = (command) => decide(command, ctx).reason ?? '';

// the L28 audit's lines for form 1: the dashed program, the same command written `git <sub>`, and the reason both must give
const AUDIT_LINES = [
  [`${EXEC_PATH}/git-push --force origin main`, 'git push --force origin main', FORCE_PUSH],
  [`${EXEC_PATH}/git-rebase -x '${RM}' HEAD~1`, `git rebase -x '${RM}' HEAD~1`, RM_OUTSIDE],
  [`${EXEC_PATH}/git-config core.editor '${RM}'`, `git config core.editor '${RM}'`, RM_OUTSIDE],
  [`${EXEC_PATH}/git-clone -c core.sshCommand='${RM}' git@h.example:o/r`, `git clone -c core.sshCommand='${RM}' git@h.example:o/r`, RM_OUTSIDE],
  [`${EXEC_PATH}/git-remote-ext r 'sh -c rm% -rf% ~/x'`, "git remote-ext r 'sh -c rm% -rf% ~/x'", RM_OUTSIDE],
  [`PATH="$PATH:${EXEC_PATH}" git-rebase -x '${RM}' HEAD~1`, `PATH="$PATH:${EXEC_PATH}" git rebase -x '${RM}' HEAD~1`, RM_OUTSIDE],
];

test('the audit lines: a git-<sub> program from the exec path or PATH asks exactly like git <sub>', () => {
  for (const [dashed, spaced, reason] of AUDIT_LINES) {
    assert.match(reasonOf(dashed), reason, dashed);
    assert.deepEqual(decide(dashed, ctx), decide(spaced, ctx), dashed);
  }
});

test('git-push --force origin main gets the verdict of git push --force origin main however the program word is written', () => {
  const expected = decide('git push --force origin main', ctx);
  const words = ['git-push', './git-push', '../libexec/git-core/git-push', `${EXEC_PATH}/git-push`, "'git-push'", '"git-push"', "$'git-push'",
    "$'\\x67it-push'", 'g\\it-push', 'command git-push', 'sudo git-push', 'nohup git-push', `env GIT_TRACE=1 ${EXEC_PATH}/git-push`];
  for (const word of words) assert.deepEqual(decide(`${word} --force origin main`, ctx), expected, word);
  // behind a wrapper no list knows, the scan of later words reads the dashed program too
  for (const wrapper of ['xcrun', 'ionice -c3', 'caffeinate -i']) assert.match(reasonOf(`${wrapper} git-push --force origin main`), FORCE_PUSH, wrapper);
});

test('every git check reads git-<sub>: --no-verify, commit -n, HUSKY=0, core.hooksPath, the commands git runs, the merge advice', () => {
  const pairs = [['git-commit --no-verify -m x', 'git commit --no-verify -m x'], ['git-commit -n -m x', 'git commit -n -m x'],
    ['HUSKY=0 git-commit -m x', 'HUSKY=0 git commit -m x'], ['git-config core.hooksPath /tmp/h', 'git config core.hooksPath /tmp/h'],
    [`git-filter-branch --tree-filter '${RM}' HEAD`, `git filter-branch --tree-filter '${RM}' HEAD`],
    [`git-submodule foreach '${RM}'`, `git submodule foreach '${RM}'`], [`git-config Core.Editor '${RM}'`, `git config Core.Editor '${RM}'`],
    ['git-merge feature', 'git merge feature'], ['git-pull', 'git pull']];
  for (const [dashed, spaced] of pairs) {
    const verdict = decide(spaced, ctx);
    assert.ok(verdict.ask === true || verdict.advice !== undefined, `${spaced} is guarded`);
    assert.deepEqual(decide(dashed, ctx), verdict, dashed);
  }
});

test('programs that only share the git- prefix, and dashed reads, stay quiet', () => {
  const quiet = ['git-lfs pull', 'git-tidy prune --base main', 'git-cliff -o CHANGELOG.md', 'git-lfs install', 'git-lfs push --all origin main',
    'node ~/.claude/tools/git-tidy/git-tidy.mjs prune', 'git-log --oneline -5', 'git-push --dry-run origin main', 'git-merge --ff-only lane/x'];
  for (const command of quiet) assert.deepEqual(decide(command, ctx), { allow: true }, command);
});

test('an unknown git-x program still has its later words scanned, and a production host still asks for a dashed program', () => {
  assert.match(reasonOf('git-foo rm -rf /x'), RM_OUTSIDE); // after `git` the scan stops; after a program the guard does not know it does not
  assert.match(reasonOf('git-lfs rm -rf /x'), RM_OUTSIDE);
  assert.match(reasonOf("ssh db1.example.com 'git-log -5'"), PROD_WRITE); // the read list names `git log`, not a program called git-log
  assert.deepEqual(decide("ssh db1.example.com 'git log -5'", ctx), { allow: true });
});

test('the raw-text backstop reads git-<sub> too: a dashed push in a heredoc a shell runs, a config write next to printf -v', () => {
  const heredoc = (program) => `xargs -I{} sh -c '{}' <<'EOF'\n${program} -f origin main\nEOF`;
  assert.ok(decide(heredoc('git push'), ctx).ask, 'the spaced form asks');
  assert.deepEqual(decide(heredoc('git-push'), ctx), decide(heredoc('git push'), ctx));
  const printfV = (program) => `printf -v E %s '${RM}'; ${program} core.editor "$E"`;
  assert.deepEqual(decide(printfV('git config'), ctx).reasons, [GIT_UNREADABLE_REASON]);
  assert.deepEqual(decide(printfV('git-config'), ctx), decide(printfV('git config'), ctx));
});
