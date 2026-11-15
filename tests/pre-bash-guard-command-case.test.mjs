// Tests for command words on file systems that ignore case in names (home/hooks/lib/command-of.mjs commandCase): on macOS and Windows
// `GIT push`, `/BIN/RM` and `GIT-PUSH` run git, rm and git push, so every rule reads them so; on Linux names are exact and `GIT` is another
// program. The platform is injected by setting process.platform around each call (the guard reads it per call), so the results do not
// depend on the machine the tests run on. Command strings are only passed to decide(); nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: [] };
const EXEC_PATH = '/Library/Developer/CommandLineTools/usr/libexec/git-core';
const FORCE_PUSH = /^DESTRUCTIVE: force push overwrites remote history/;
const RM_OUTSIDE = /^DESTRUCTIVE: rm -r outside the project/;
const NO_VERIFY = 'git --no-verify skips the git hooks';
const PUSHES = ['GIT push --force origin main', '/usr/bin/GIT push --force origin main', `${EXEC_PATH}/GIT-PUSH --force origin main`,
  'Git push -f origin main', 'SUDO GIT push -f origin main', 'xcrun GIT push -f origin main'];
const REMOVALS = ['RM -rf ~/x', '/BIN/RM -rf ~/x', 'Rm -rf ~/x', 'NOHUP RM -rf ~/x'];

/** decide() as it runs on `platform`: process.platform is replaced for the call and restored after it. */
function decideOn(platform, command) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return decide(command, ctx);
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}
const reasonOn = (platform, command) => decideOn(platform, command).reason ?? '';

test('on macOS a command word in any case is the command the file system runs: git, git-<sub>, rm, wrappers', () => {
  for (const command of PUSHES) assert.match(reasonOn('darwin', command), FORCE_PUSH, command);
  for (const command of REMOVALS) assert.match(reasonOn('darwin', command), RM_OUTSIDE, command);
  assert.equal(reasonOn('darwin', 'GIT commit --no-verify -m x'), NO_VERIFY);
  assert.deepEqual(decideOn('darwin', '$EDITOR notes.md'), { allow: true }); // a variable's name keeps its case: $EDITOR is not $editor
  const heredoc = (git) => `xargs -I{} sh -c '{}' <<'EOF'\n${git} push -f origin main\nEOF`; // the raw-text backstop reads it too
  assert.deepEqual(decideOn('darwin', heredoc('GIT')), decideOn('darwin', heredoc('git')));
});

test('on Windows names ignore case as before', () => {
  assert.match(reasonOn('win32', PUSHES[0]), FORCE_PUSH);
  assert.match(reasonOn('win32', `${EXEC_PATH}/GIT-PUSH --force origin main`), FORCE_PUSH);
});

test('on Linux names are exact: GIT and RM are other programs, git and rm are still read', () => {
  for (const command of ['GIT push --force origin main', 'RM -rf ~/x', `${EXEC_PATH}/GIT-PUSH --force origin main`]) {
    assert.deepEqual(decideOn('linux', command), { allow: true }, command);
  }
  assert.match(reasonOn('linux', 'git push --force origin main'), FORCE_PUSH);
  assert.match(reasonOn('linux', 'rm -rf ~/x'), RM_OUTSIDE);
});
