// Tests for the values of the variables git runs (home/hooks/lib/git-run-values.mjs) and for what `git config` writes after `--`
// (home/hooks/lib/git-runs.mjs, configWrites), as the Bash guard reads them: a GIT_EDITOR, GIT_PAGER, GIT_SSH_COMMAND ... value is checked
// wherever the line assigns it (in front of a command, `export`, `declare -x`, a plain statement, `${NAME:=value}`), with git later in the
// line or not; a value the guard cannot read asks "git runs a command this guard cannot read", except one reference to a variable the line
// does not write (`"$EDITOR"`). The L28 audit's lines for forms 2-4, the quiet list of the spec and hostile shapes. Command strings are
// only passed to decide(); nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { COMMAND_ENV, GIT_UNREADABLE_REASON } from '../home/hooks/lib/git-runs.mjs';
import { MAX_COMMAND_CHARS } from '../home/hooks/lib/verdict.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { fastestMs } from './timing.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: [] };
const RM = 'rm -rf ~/x';
const RM_OUTSIDE = /^DESTRUCTIVE: rm -r outside the project/;
const RISKY = /^DESTRUCTIVE: risky word inside shell expansion/;
const MAX_MS = 5000; // the bound the other hostile-input tests use

const reasonsOf = (command) => decide(command, ctx).reasons ?? [];
const reasonOf = (command) => decide(command, ctx).reason ?? '';
const assertAll = (commands, check) => commands.forEach((command) => check(command));
const asksRm = (command) => assert.match(reasonOf(command), RM_OUTSIDE, command);
const asksUnreadable = (command) => assert.deepEqual(reasonsOf(command), [GIT_UNREADABLE_REASON], command);
const asksUnreadableToo = (command) => assert.ok(reasonsOf(command).includes(GIT_UNREADABLE_REASON), command);
const quiet = (command) => assert.deepEqual(decide(command, ctx), { allow: true }, command);

test('the audit lines of form 2: a value set earlier in the line asks with its own reason, or as unreadable', () => {
  assertAll(['export GIT_EDITOR="rm -rf $HOME/x"; git commit', `: \${GIT_EDITOR:='${RM}'}; export GIT_EDITOR; git commit`,
    `eval "export GIT_EDITOR='${RM}'"; git commit`], asksRm);
  assertAll(['A=r; B="${A}m -rf ~/x"; GIT_EDITOR="$B" git commit', `GIT_EDITOR="$(printf '\\x72m -rf ~/x')" git commit`,
    'GIT_EDITOR="$(echo cm0gLXJmIH4veA== | base64 -d)" git commit'], asksUnreadable);
});

test('every assignment form and every git-run name is read, in any quoting, with git after it, before it or not at all', () => {
  const forms = [(v) => `export GIT_EDITOR=${v}`, (v) => `declare -x GIT_EDITOR=${v}`, (v) => `typeset -x GIT_EDITOR=${v}`,
    (v) => `declare -gx GIT_EDITOR=${v}`, (v) => `local GIT_EDITOR=${v}`, (v) => `readonly GIT_EDITOR=${v}`, (v) => `GIT_EDITOR=${v}`,
    (v) => `GIT_EDITOR=${v} make`, (v) => `env -i GIT_EDITOR=${v} make`, (v) => `sudo GIT_EDITOR=${v} make`, (v) => `command export GIT_EDITOR=${v}`,
    (v) => `git commit; export GIT_EDITOR=${v}`, (v) => `export GIT_EDITOR=${v}; git commit`, (v) => `X=1 GIT_EDITOR=${v} git commit`];
  const quotings = [`'${RM}'`, `"${RM}"`, `$'${RM}'`, "$'\\x72m -rf ~/x'", `"rm -rf \${HOME}/x"`];
  for (const form of forms) assertAll(quotings.map(form), asksRm);
  assertAll([`: \${GIT_EDITOR:=${RM}}`, `: "\${GIT_EDITOR:=${RM}}"`, `\${GIT_EDITOR='${RM}'}; git commit`, `echo "\${GIT_PAGER=${RM}}"`], asksRm);
  assertAll(COMMAND_ENV.map((name) => `export ${name}='${RM}'`), asksRm);
  assertAll([`B='${RM}'; GIT_EDITOR="$B" git commit`, `eval "GIT_PAGER='${RM}'"`, `bash -c "export GIT_SSH_COMMAND='${RM}'"`], asksRm);
  quiet(`export NOT_RUN_BY_GIT='${RM}'`); // only the names git runs
});

test('a value the guard cannot read asks: a substitution, a backtick, ${...} with an operator, a variable as command word or one the line writes', () => {
  assertAll(['export GIT_EDITOR="$(cat f)"', 'GIT_EDITOR=$(cat f) git commit', 'GIT_EDITOR="a `cat f`" git commit', 'GIT_EDITOR=`cat f` git commit',
    'export GIT_PAGER=`cat f`', 'GIT_SSH_COMMAND="$SSH -i k" git fetch', 'GIT_EDITOR="$EDITOR --wait" git commit', 'export EDITOR=$(which vim)',
    'read -r B < f; GIT_EDITOR="$B" git commit', 'for B in a; do GIT_EDITOR="$B" git commit; done',
    'GIT_SSH_COMMAND="$(cat ssh-cmd)" git fetch', 'export GIT_EDITOR="${EDITOR:=vim}"'], asksUnreadable);
  // `+=` adds to a value the line did not set (the guard also reads `NAME+=x` as a command word, as before)
  assert.ok(reasonsOf('GIT_EDITOR+=" -f" git commit').includes(GIT_UNREADABLE_REASON));
  assert.match(reasonOf(`GIT_EDITOR=vim; GIT_EDITOR+='; ${RM}'`), RM_OUTSIDE); // a value the line set is read with what is added
  // a substitution that also names a dangerous word keeps the bounce it had: the unreadable ask joins it
  const pager = `GIT_PAGER="$(echo ${RM})" git log`;
  assert.match(reasonOf(pager), RISKY);
  assert.ok(reasonsOf(pager).includes(GIT_UNREADABLE_REASON), pager);
});

test('audit follow-up: a reference glued to text, a config value from a substitution, a placeholder, a name written out of sight', () => {
  const glued = 'A=r; V="${A}m -rf ~/";'; // `"$V"x` is the value of V and an x
  assertAll([`${glued} GIT_EDITOR="$V"x git commit`, `${glued} export GIT_EDITOR="$V"x; git commit`, `${glued} git -c core.editor="$V"x commit`,
    `X="$(printf '%sm -rf ~/x' r)"; git -c core.editor="$X" commit`, 'X="$(cat f)"; git config core.editor "$X"',
    'X="$(cat f)"; git clone -c core.sshCommand="$X" ../src dst', 'X=$((1 + 2)); GIT_PAGER="$X" git log',
    "printf '%sm -rf ~/x' r | xargs -I{} env GIT_EDITOR={} git commit", 'echo vim | xargs -I X env GIT_EDITOR=X git commit',
    'find . -name x -exec env GIT_EDITOR={} git commit \\;', "read -r GIT_EDITOR <<< 'rm -rf $HOME/x'; export GIT_EDITOR; git commit",
    "printf -v GIT_EDITOR '%sm -rf ~/x' r; export GIT_EDITOR; git commit", 'mapfile -t GIT_PAGER < f; git log', 'getopts e GIT_EDITOR',
    `N=EDI; M=TOR; printf -v "$N$M" '%sm -rf ~/x' r; GIT_EDITOR="$EDITOR" git commit`, 'for GIT_EDITOR in vim; do git commit; done',
    `printf -v "$1" '%sm -rf ~/x' r; GIT_EDITOR="$EDITOR" git commit`, 'X="$(cat f)"; GIT_EDITOR="vim $X" git commit',
    'X=`cat f`; GIT_EDITOR="$X" git commit', "X=`printf '%sm -rf ~/x' r`; git -c core.editor=\"$X\" commit", 'X=`cat f`; git config core.editor "$X"',
    'X=pre`cat f`; export GIT_EDITOR="$X"; git commit', 'X=`cat f` GIT_PAGER=$X git log'], asksUnreadableToo);
  // the parsers lose a backtick's value: the variable is unknown for every rule, not empty; `pwd` and mktemp stay known
  assert.ok(decide('X=`echo rm`; $X -rf ~/x', ctx).ask);
  quiet('D=`pwd`; GIT_EDITOR="$D/bin/ed" git commit');
  // one value run in two directories: harmless in the project, outside it once git runs it after cd /
  quiet("GIT_EDITOR='rm -rf build'; git commit");
  asksRm("GIT_EDITOR='rm -rf build'; cd /; git commit");
  asksRm(`GIT_EDITOR="\${X:-${RM}}" git commit`); // the literal of a default is judged
});

test('the spec quiet list and one reference to a variable the line does not write stay silent', () => {
  assertAll(['GIT_EDITOR=true git rebase --continue', 'GIT_PAGER=cat git diff', 'export EDITOR=vim', 'export GIT_EDITOR="code --wait"',
    'GIT_EDITOR="$EDITOR" git commit', 'export PAGER=less', 'git-lfs pull', 'git-tidy prune --base main', 'git-cliff -o CHANGELOG.md',
    "GIT_SSH_COMMAND='ssh -i key' git fetch"], quiet);
  assertAll(['GIT_EDITOR="${VISUAL}" git commit', 'GIT_PAGER=$PAGER git log', 'export EDITOR="$VISUAL"', 'GIT_PAGER="$P" git log',
    'GIT_SSH_COMMAND="ssh -i $HOME/.ssh/k" git fetch', 'GIT_SSH_COMMAND="ssh -i ~/.ssh/k -o IdentitiesOnly=yes" git fetch', ': "${EDITOR:=vim}"',
    'export GIT_PAGER=', 'EDITOR= git commit', "export VISUAL='code --wait'"], quiet);
  // a default `${NAME:-literal}` judges the literal; a variable only as an argument is an opaque argument
  assertAll(['export EDITOR="${EDITOR:-vim}"', 'export PAGER=${PAGER:-less}', 'GIT_PAGER="${PAGER:-less}" git log', 'GIT_EDITOR="${X:-vim}" git commit',
    'GIT_SSH_COMMAND="ssh -i $KEY" git fetch', 'GIT_EDITOR="code --wait $FILE" git commit', 'GIT_EDITOR="vim $X" git commit',
    'GIT_PAGER="less -R $LESSOPTS" git log', 'GIT_EDITOR="$HOME/bin/ed" git commit', 'git -c core.pager="less $OPTS" log'], quiet);
});

test('form 3: in git config writes `--` ends the options and the words after it are still key and value', () => {
  assertAll([`git config core.sshCommand -- '--x; ${RM}'`, `git config core.editor -- '-x; ${RM}'`], asksRm); // the audit lines
  assertAll([`git config --global core.editor -- '-x; ${RM}'`, `git config -- core.editor '${RM}'`, `git config core.editor '-x; ${RM}'`,
    `git config --add core.editor -- '-x; ${RM}'`, `git config CORE.EDITOR -- '-x; ${RM}'`, `git config --global --add -- core.sshCommand '-x; ${RM}'`,
    `git config core.editor --global '${RM}'`, `git-config core.editor -- '-x; ${RM}'`], asksRm);
  assertAll(['git config core.editor -- vim', 'git config -- core.pager less', 'git config --global core.editor "code --wait"', 'git config -- user.name x'], quiet);
});

test('form 4: git config set writes its value like the legacy form', () => {
  assertAll([`git config set core.editor '${RM}'`, `git config set --global core.editor '${RM}'`, `git config set --file .git/config core.editor '${RM}'`,
    `git config set --append core.pager '${RM}'`], asksRm);
  assertAll(['git config set core.editor vim', 'git config set --global core.pager "less -R"'], quiet);
});

test('hostile shapes stay bounded: a value repeated by many git commands, many values, many keys', () => {
  const quote = (text, level) => (level % 2 === 0 ? `'${text.replaceAll("'", "'\\''")}'` : `"${text.replace(/["\\$`]/g, (c) => `\\${c}`)}"`);
  let manyGits = RM; // each level sets the pager and runs git four times: once exponential, now each value is judged once per line
  for (let level = 0; level < 12; level += 1) manyGits = `export GIT_PAGER=${quote(manyGits, level)}; git log; git log; git log; git log`;
  const values = `export ${Array.from({ length: 1500 }, (_, i) => `GIT_PAGER=p${i}`).join(' ')}`;
  const defaults = `: ${'${GIT_EDITOR:=vim} '.repeat(1500)}`;
  const keys = `git config ${'core.editor '.repeat(2700)}`;
  for (const command of [manyGits, values, defaults, keys]) assert.ok(command.length <= MAX_COMMAND_CHARS, 'parsed, not too long');
  assert.match(reasonOf(manyGits), RM_OUTSIDE);
  assertAll([values, defaults, keys], quiet);
  const fastest = fastestMs(() => [manyGits, values, defaults, keys].forEach((command) => decide(command, ctx)));
  assert.ok(fastest < MAX_MS, `took too long (fastest of 3: ${fastest.toFixed(1)} ms)`);
});
