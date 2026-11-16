// Tests for lib/branch-move.mjs through the Bash guard: moving a branch ref by plumbing (update-ref, branch -f, push/fetch to `.`) is
// advice (C37): the first send is denied with "land with git -C <folder> merge --ff-only <lane>", the identical retry runs. Deleting
// a ref and refs outside refs/heads/ stay silent. Command strings are only passed to decide() or the hook; nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { hookEnv } from './hook-env.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };
// the spec's wording: how to land instead, and why update-ref is wrong when the branch is checked out somewhere
const BRANCH_MOVE_ADVICE = 'Land with git -C <folder where the branch is checked out> merge --ff-only <lane> (C37): update-ref, '
  + "branch -f and push/fetch to . move the branch but leave that folder's files and index behind. "
  + 'If no folder has the branch checked out, send the same command again and it runs.';

const MOVES = [
  'git update-ref refs/heads/main abc123', 'git -C ../repo update-ref refs/heads/main abc123',
  'git --git-dir=../repo/.git update-ref refs/heads/main abc', 'git --git-dir ../repo/.git update-ref refs/heads/main abc',
  'git update-ref -m "land lane" refs/heads/main abc', 'git update-ref --no-deref refs/heads/main abc def',
  'git update-ref --create-reflog refs/heads/lane abc', 'git update-ref -m land --no-deref refs/heads/main abc', 'git update-ref HEAD abc',
  'cd ../repo && git update-ref refs/heads/main abc', 'sudo git update-ref refs/heads/main abc', 'git "update-ref" refs/heads/main abc',
  "printf 'update refs/heads/main abc\\n' | git update-ref --stdin", "git update-ref --stdin <<'EOF'\nupdate refs/heads/main abc\nEOF",
  "printf 'create refs/heads/x\\0abc\\0' | git update-ref -z --stdin", "echo 'start\nupdate  refs/heads/main abc\ncommit' | git -C ../r update-ref --stdin",
  'git branch -f main abc', 'git branch --force main abc', 'git branch -f lane', 'git -C ../repo branch -f main lane',
  'git branch -f -- main abc', 'git branch main abc -f',
  'git fetch . lane:main', 'git fetch . +lane:main', 'git fetch -q . lane:refs/heads/main', 'git -C ../repo fetch . lane:main',
  'git fetch ./ lane:main',
];
const ALLOWED = [
  'git update-ref -d refs/heads/lane', 'git update-ref -d refs/heads/lane abc', 'git update-ref -m gone -d refs/heads/lane',
  'git update-ref refs/backup/main abc', 'git update-ref refs/tags/v1 abc', 'git update-ref refs/remotes/origin/main abc',
  'git update-ref refs/stash abc', 'git update-ref refs/notes/x abc', 'git update-ref --no-deref HEAD abc',
  "printf 'delete refs/heads/x\\n' | git update-ref --stdin", "printf 'update refs/backup/x abc\\n' | git update-ref --stdin",
  "printf 'verify refs/heads/x abc\\n' | git update-ref --stdin",
  'git branch lane', 'git branch lane abc', 'git branch -d lane', 'git branch -D lane', 'git branch -m a b', 'git branch --list',
  'git branch -c a b', 'git switch -c lane', 'git checkout -b lane',
  'git fetch origin', 'git fetch origin main', 'git fetch . lane', 'git fetch . lane:refs/backup/lane', 'git fetch . refs/heads/x:refs/remotes/o/x',
  'git rev-parse refs/heads/main', 'git show-ref', 'git for-each-ref refs/heads', 'git log --grep=update-ref',
  'echo git update-ref refs/heads/main x', 'echo "git branch -f main x"', "cat <<'EOF'\ngit update-ref refs/heads/main x\nEOF",
  'git switch main && git merge --ff-only lane', 'git -C ../repo merge --ff-only lane', 'git commit -m "no update-ref refs/heads/main"',
];

test('C37: moving a branch ref by plumbing gets the landing advice (update-ref, --stdin update/create, branch -f, fetch .)', () => {
  for (const command of MOVES) assert.deepEqual(decide(command, ctx), { allow: true, advice: [BRANCH_MOVE_ADVICE] }, JSON.stringify(command));
});

test('C37: ref deletes, refs outside refs/heads/, a detaching --no-deref HEAD, new branches and text that only names update-ref stay silent', () => {
  for (const command of ALLOWED) assert.deepEqual(decide(command, ctx), { allow: true }, JSON.stringify(command));
});

test('C37: git push . lane:main still asks like any push, the landing advice carried apart; push . to refs/backup carries none', () => {
  const push = decide('git push . lane:main', ctx);
  assert.equal(push.ask, true);
  assert.deepEqual(push.advice, [BRANCH_MOVE_ADVICE]);
  for (const command of ['git push . +lane:refs/heads/main', 'git push -q ./ HEAD:main']) assert.deepEqual(decide(command, ctx).advice, [BRANCH_MOVE_ADVICE], command);
  assert.equal(decide('git push . lane:refs/backup/lane', ctx).advice, undefined);
});

test('C37 through the hook: git update-ref refs/heads/main is denied once with the advice, the identical retry runs', () => {
  const home = mkdtempSync(join(tmpdir(), 'branch-move-home-'));
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: PROJECT });
  const send = (command) => {
    const input = JSON.stringify({ cwd: PROJECT, session_id: 'sess-1', tool_input: { command } });
    const { status, stdout, stderr } = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env });
    assert.equal(status, 0, stderr);
    return stdout === '' ? { decision: 'allow' } : JSON.parse(stdout).hookSpecificOutput;
  };
  const first = send('git update-ref refs/heads/main abc');
  assert.equal(first.permissionDecision, 'deny');
  assert.ok(first.permissionDecisionReason.includes(BRANCH_MOVE_ADVICE), first.permissionDecisionReason);
  assert.deepEqual(send('git update-ref refs/heads/main abc'), { decision: 'allow' });
});
