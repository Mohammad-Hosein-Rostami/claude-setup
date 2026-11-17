// A dangerous word written as DATA is not a reason to ask: in a single-quoted argument of a program that never runs its arguments
// (echo, printf, grep, rg, jq, sed without e/w, git log), even next to an unrelated `$(...)`. Round 4 replay of the guard log (2026-11-17): 78 bounces and 27 dialogs
// of the "risky word inside shell expansion" class, a part of them `sed 's/rm -rf .../'` or `printf '... git push ...'` next to `$(date)`.
// Every program that runs its arguments (shells, interpreters, eval, ssh, xargs, env, sudo, find -exec, watch, flock, tmux, docker exec,
// kubectl exec, parallel, git rebase --exec) stays flagged, and so does any shape where the quoted text can still reach a shell
// (a pipe into anything that is not a data program, a file the line writes, `$(...)` output used as a command, a double-quoted word).
// Command strings are only parsed; nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { riskyWordInExpansion } from '../home/hooks/lib/raw-risk.mjs';

const OTHER_CONSTRUCT = '$(date)'; // an unrelated hidden construct: what makes the raw-text rule look at the line at all
const flagged = (command) => riskyWordInExpansion(command) !== undefined;

test('a dangerous word in a single-quoted argument of a data program is not flagged', () => {
  for (const command of [
    `echo 'rm -rf /tmp/x' ${OTHER_CONSTRUCT}`,
    `echo ${OTHER_CONSTRUCT} 'rm -rf /tmp/x'`,
    `printf '%s\\n' 'git push origin main' "${OTHER_CONSTRUCT}"`,
    `grep 'rm -rf /x' notes.txt ${OTHER_CONSTRUCT}`,
    `grep -e 'git push' notes.txt ${OTHER_CONSTRUCT}`,
    `rg 'git push' src ${OTHER_CONSTRUCT}`,
    `sed 's/rm -rf \\/x/y/' notes.txt ${OTHER_CONSTRUCT}`,
    `sed -n -e 's/git push/x/p' notes.txt ${OTHER_CONSTRUCT}`,
    `jq '.a | "rm -rf /x"' notes.json ${OTHER_CONSTRUCT}`,
    `git log --grep='git push' ${OTHER_CONSTRUCT}`,
    `git log --grep 'rm -rf /x' ${OTHER_CONSTRUCT}`,
    `FOO=1 echo 'rm -rf /x' ${OTHER_CONSTRUCT} 2>/dev/null`,
    `git commit -m 'rm -rf /x' ${OTHER_CONSTRUCT}`, // already data before this change (lib/message-text.mjs); kept in the list as an entry
  ]) assert.equal(flagged(command), false, command);
});

test('twin: the same word outside a single-quoted data argument is still flagged', () => {
  for (const command of [
    `echo "rm -rf /tmp/x" ${OTHER_CONSTRUCT}`,
    `echo 'x'; rm -rf /tmp/x ${OTHER_CONSTRUCT}`,
    `grep 'x' notes.txt; git push origin main ${OTHER_CONSTRUCT}`,
    `echo 'rm -rf /tmp/x'$(date)`.replace("'$(date)", "'$(echo rm -rf /y)"),
    `echo 'x' $(rm -rf /tmp/x)`,
  ]) assert.equal(flagged(command), true, command);
});

test('data that can reach a shell stays flagged: pipe, file, command substitution', () => {
  for (const command of [
    `echo 'rm -rf /tmp/x' | sh ${OTHER_CONSTRUCT}`,
    `echo 'rm -rf /tmp/x' | bash`.concat(` ${OTHER_CONSTRUCT}`),
    `printf 'rm -rf /tmp/x' | xargs ${OTHER_CONSTRUCT}`,
    `for f in a; do echo 'rm -rf /tmp/x'; done | sh ${OTHER_CONSTRUCT}`,
    `{ echo 'rm -rf /tmp/x'; } | sh ${OTHER_CONSTRUCT}`,
    `echo 'rm -rf /tmp/x' | tee run.sh ${OTHER_CONSTRUCT}`, // a reader that writes a file a later `sh run.sh` runs
    `echo 'rm -rf /tmp/x' > run.sh ${OTHER_CONSTRUCT}`,
    `echo 'rm -rf /tmp/x' >> run.sh ${OTHER_CONSTRUCT}`,
    `sh -c "$(echo 'rm -rf /tmp/x')"`,
    `eval "$(printf 'rm -rf /tmp/x')"`,
    "x=`echo 'rm -rf /tmp/x'`; eval $x",
    `echo 'rm -rf /tmp/x' > >(sh) ${OTHER_CONSTRUCT}`,
  ]) assert.equal(flagged(command), true, command);
});

test('a data program with a flag or script that runs text stays flagged', () => {
  for (const command of [
    `sed 's/a/b/e # rm -rf /tmp/x' notes.txt ${OTHER_CONSTRUCT}`,
    `sed 'e rm -rf /tmp/x' notes.txt ${OTHER_CONSTRUCT}`,
    `sed 's/a/b/w /tmp/x' notes.txt ${OTHER_CONSTRUCT}; git push`,
    `sed -n '1e rm -rf /tmp/x' notes.txt ${OTHER_CONSTRUCT}`,
    `rg --pre 'rm -rf /tmp/x' pattern . ${OTHER_CONSTRUCT}`,
    `rg --pre='x' 'rm -rf /tmp/x' . ${OTHER_CONSTRUCT}`,
    `printf -v CMD '%s' 'rm -rf /tmp/x' ${OTHER_CONSTRUCT}`,
    `git -c core.pager=x log 'rm -rf /tmp/x' ${OTHER_CONSTRUCT}`, // an option before `log`: not the plain `git log` shape
    `git rebase --exec x 'rm -rf /tmp/x' ${OTHER_CONSTRUCT}`,
  ]) assert.equal(flagged(command), true, command);
});

test('a program that runs its arguments is never a data program (one negative each)', () => {
  const runners = [
    "git rebase --exec 'rm -rf /tmp/x' main",
    "git rebase -x 'rm -rf /tmp/x' main",
    "watch 'rm -rf /tmp/x'",
    "flock /tmp/l -c 'rm -rf /tmp/x'",
    "su -c 'rm -rf /tmp/x'",
    "script -c 'rm -rf /tmp/x' out",
    "tmux new 'rm -rf /tmp/x'",
    "docker exec c 'rm -rf /tmp/x'",
    "kubectl exec pod -- 'rm -rf /tmp/x'",
    "parallel 'rm -rf /tmp/x' ::: a",
    "bash -c 'rm -rf /tmp/x'",
    "sh -c 'rm -rf /tmp/x'",
    "python3 -c 'rm -rf /tmp/x'",
    "node -e 'rm -rf /tmp/x'",
    "eval 'rm -rf /tmp/x'",
    "ssh host 'rm -rf /tmp/x'",
    "xargs sh -c 'rm -rf /tmp/x'",
    "env sh -c 'rm -rf /tmp/x'",
    "sudo sh -c 'rm -rf /tmp/x'",
    "find . -exec sh -c 'rm -rf /tmp/x' ;",
    "nohup sh -c 'rm -rf /tmp/x'",
    "time sh -c 'rm -rf /tmp/x'",
    "echo x | sh -c 'rm -rf /tmp/x'",
  ];
  for (const runner of runners) assert.equal(flagged(`${runner} ${OTHER_CONSTRUCT}`), true, runner);
});

test('through decide(): the data shape needs no owner, the runner next to it still asks', () => {
  const ctx = { cwd: '/work/proj', project: '/work/proj' };
  assert.equal(decide(`printf '%s\\n' 'rm -rf /tmp/x' ${OTHER_CONSTRUCT}`, ctx).allow, true);
  assert.equal(decide(`printf '%s\\n' 'x' ${OTHER_CONSTRUCT}; sh -c 'rm -rf /tmp/x'`, ctx).allow, false);
});
