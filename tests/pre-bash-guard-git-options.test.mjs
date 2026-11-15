// Tests for git's own options before the subcommand (home/hooks/lib/git-options.mjs) as the Bash guard reads them: every global option
// form of git 2.54 (`git help git`, plus `--shallow-file` from git.c and `--super-prefix` of older gits), options git does not know yet (a
// later git may add one that takes a value), and combinations. An option value must never pose as the subcommand: a force push,
// --no-verify, core.hooksPath, alias.*, a merge commit and a production-host write are still found behind any of them, and ordinary
// commands stay silent. Command strings are only passed to decide() and parseGitArgs(); nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseGitArgs } from '../home/hooks/lib/git-options.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { fastestMs } from './timing.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: ['db1.example.com'] };
const FORCE_PUSH = /^DESTRUCTIVE: force push overwrites remote history/;
const PUSH = 'push -f origin main';

// Every global option form git 2.54 accepts, with a value where it takes one.
const KNOWN_FORMS = [
  '-C x', '-c d=e', '--config-env a.b=C', '--config-env=a.b=C', '--git-dir x', '--git-dir=x', '--work-tree x', '--work-tree=x',
  '--namespace x', '--namespace=x', '--attr-source x', '--attr-source=x', '--shallow-file x', '--super-prefix x', '--super-prefix=x',
  '--exec-path', '--exec-path=x', '--list-cmds=x', '--html-path', '--man-path', '--info-path', '-p', '--paginate', '-P', '--no-pager',
  '--bare', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs',
  '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '-h', '--help', '-v', '--version',
];
// Option words git 2.54 rejects: a later git may accept them, with or without a value.
const UNKNOWN_FORMS = ['--future-option x', '--future-option', '--future-option=x', '-X x', '--', '-Cx', '-cd=e', '--shallow-file=x'];

const reasonOf = (command) => decide(command, ctx).reason ?? '';

test('every global option form, and an option git does not know yet, still leaves push -f origin main a force push', () => {
  for (const form of [...KNOWN_FORMS, ...UNKNOWN_FORMS]) assert.match(reasonOf(`git ${form} ${PUSH}`), FORCE_PUSH, form);
});

test('combinations: options in a row, an unknown option before a value option, an unknown option with a value-like word', () => {
  const combinations = [
    `git -C x --config-env a.b=C -c d=e ${PUSH}`, `git --config-env a.b=C --attr-source HEAD --no-pager ${PUSH}`,
    `git --future-option -C x ${PUSH}`, `git --future-option x --future-option y ${PUSH}`, `git -c x=y --future-option z -C w ${PUSH}`,
    `git --shallow-file f --super-prefix p/ --namespace n ${PUSH}`,
  ];
  for (const command of combinations) assert.match(reasonOf(command), FORCE_PUSH, command);
  assert.match(reasonOf('git -C x --config-env a.b=C -c d=e push'), /^git push publishes commits/, 'a plain push asks too');
  // read as a flag: `commit -n` (an ask); taking `commit` as its value: `-n` may be another such option, then a force push
  assert.match(reasonOf(`git --future-option commit -n ${PUSH}`), FORCE_PUSH, 'the most dangerous reading decides');
});

test('core.hooksPath and alias.* set through --config-env (both forms), or after an unknown option, ask like -c does', () => {
  const hooksPath = [
    'git --config-env core.hooksPath=HOOKS commit -m x', 'git --config-env=core.hooksPath=HOOKS commit -m x',
    'git -C x --config-env CORE.HOOKSPATH=H commit', 'git --future-option x -c core.hooksPath=/dev/null commit -m y',
  ];
  for (const command of hooksPath) assert.equal(reasonOf(command), 'git -c core.hooksPath bypasses the git hooks', command);
  for (const command of ['git --config-env alias.p=PUSH p', 'git --config-env=alias.p=PUSH p', 'git --future-option x -c alias.p=push p']) {
    assert.match(reasonOf(command), /^git -c alias\.\* defines a command for this call/, command);
  }
});

test('--no-verify and commit -n behind the value options git added later still ask', () => {
  const commands = [
    'git --attr-source HEAD commit -n -m x', 'git --config-env a.b=C commit --no-verify -m x', 'git --shallow-file f commit -nm x',
    'git --future-option v commit -n', 'git --super-prefix p/ push --no-verify',
  ];
  for (const command of commands) assert.equal(reasonOf(command), 'git --no-verify skips the git hooks', command);
});

test('a merge that can create a merge commit gets the C37 advice behind any option form; --ff-only behind them stays silent', () => {
  for (const form of [...KNOWN_FORMS, ...UNKNOWN_FORMS]) assert.equal(decide(`git ${form} merge lane/x`, ctx).advice?.length, 1, form);
  for (const form of ['--config-env a.b=C', '--attr-source HEAD', '-C x', '--no-pager']) {
    assert.deepEqual(decide(`git ${form} merge --ff-only lane/x`, ctx), { allow: true }, form);
  }
});

test('git on a production host: an option value never passes for a read-only subcommand; option values still ask as before', () => {
  const writes = [
    "ssh db1.example.com 'git -C log reset --hard'", "ssh db1.example.com 'git --git-dir status clean -fdx'",
    "ssh db1.example.com 'git --work-tree diff checkout -- .'", "ssh db1.example.com 'git --attr-source show pull'",
    "ssh db1.example.com 'git --future-option log reset --hard'", "ssh db1.example.com 'git -C /srv/app status'",
  ];
  for (const command of writes) assert.match(reasonOf(command), /^ssh may change db1\.example\.com, a production host/, command);
  for (const command of ["ssh db1.example.com 'git log -5'", "ssh db1.example.com 'git --no-pager status'"]) {
    assert.deepEqual(decide(command, ctx), { allow: true }, command);
  }
});

test('ordinary git commands with global options stay silent (no false alarms)', () => {
  const ordinary = [
    'git -C ../repo status', 'git --no-pager log --oneline -5', 'git -c color.ui=always diff', 'git --git-dir=.git --work-tree=. status',
    'git --config-env=core.editor=EDITOR commit -m x', 'git --config-env core.editor=EDITOR commit -m x', 'git --attr-source HEAD diff',
    'git -P show HEAD', 'git --literal-pathspecs add -- a', 'git --version', 'git -C x fetch origin', 'git --no-optional-locks status',
    'git --exec-path', 'git --list-cmds=main', 'git -c user.name=x -c user.email=y commit -m z', 'git --future-option status',
  ];
  for (const command of ordinary) assert.deepEqual(decide(command, ctx), { allow: true }, command);
  // a known option's value is only a value: a directory or tree named `commit` does not make `status -n` a `commit -n`
  const valueOptions = ['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source', '--shallow-file', '--super-prefix'];
  for (const option of valueOptions) assert.deepEqual(decide(`git ${option} commit status -n`, ctx), { allow: true }, option);
});

test('parseGitArgs: known options give one reading; an unknown option is read as a flag and as taking the next word', () => {
  assert.deepEqual(parseGitArgs(['-C', 'x', '--no-pager', 'push', '-f']), {
    options: [['-C', 'x'], ['--no-pager']], subcommands: [{ sub: 'push', rest: ['-f'] }],
  });
  assert.deepEqual(parseGitArgs(['--future-option', 'x', 'push']).subcommands, [{ sub: 'x', rest: ['push'] }, { sub: 'push', rest: [] }]);
  assert.deepEqual(parseGitArgs([]), { options: [], subcommands: [{ sub: undefined, rest: [] }] });
  assert.deepEqual(parseGitArgs(['-C']), { options: [['-C', undefined]], subcommands: [{ sub: undefined, rest: [] }] });
});

test('32 KB of unknown options still finds the push and finishes in seconds (each word starts at most one reading)', () => {
  const pairs = `git ${'--future-option x '.repeat(1800)}${PUSH}`; // a possible subcommand at every second word
  const pushes = `git ${'--future-option push '.repeat(1550)}origin main`; // and each one a push to parse
  assert.match(reasonOf(pairs), FORCE_PUSH);
  assert.match(reasonOf(pushes), /^git push publishes commits/);
  const fastest = fastestMs(() => [pairs, pushes].forEach((command) => decide(command, ctx)));
  assert.ok(fastest < 5000, `took too long (fastest of 3: ${fastest.toFixed(1)} ms)`);
});
