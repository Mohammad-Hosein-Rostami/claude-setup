// Tests for the Bash guard's deleter forms found missing in the last review rounds (G2, N5, G8, N6, N8, X3 heredoc). Each form has the line that
// must now be judged (or no longer asked), and the hostile neighbours that must still ask. Command strings are only passed to decide(); nothing runs.
// Project /work/proj, started in it. G9 (the hook temp root under a shared /tmp) was already built: tests/edit-log-root.test.mjs (b), (d), (e).
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { commandOf } from '../home/hooks/lib/command-of.mjs';
import { lex, tokenize } from '../home/hooks/lib/shell-words.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const RM = 'rm'; // kept apart so this file's own text never reads as a command
const ctx = { cwd: PROJECT, project: PROJECT };
const asks = (command) => decide(command, ctx).ask === true;
const silent = (command) => decide(command, ctx).allow === true;
const assertAllAsk = (commands) => commands.forEach((command) => assert.ok(asks(command), `should ask: ${JSON.stringify(command)}`));
const assertAllSilent = (commands) => commands.forEach((command) => assert.ok(silent(command), `should allow: ${JSON.stringify(command)}`));

test('G2: a redirection in front of cd does not hide the cd', () => {
  assertAllAsk([
    `2>/dev/null cd .. && ${RM} -rf proj`,
    `>/dev/null cd .. && ${RM} -rf proj`,
    `> /dev/null cd .. && ${RM} -rf proj`,
    `2> /dev/null cd .. && ${RM} -rf proj`,
    `2>&1 cd .. && ${RM} -rf proj`,
    `X=1 >/dev/null cd .. && ${RM} -rf proj`,
  ]);
  // from every folder the line may be in the target is inside the project or a temp folder: no ask, the same as without the redirection
  assertAllSilent([`>/dev/null cd src && ${RM} -rf gen`, `>/dev/null cd /tmp && ${RM} -rf proj`]);
  assert.ok(asks(`>/dev/null git push --force`), 'a redirection in front of another command still reads that command');
});

test('G2: the command word behind leading redirections is the command, in both parsers', () => {
  for (const parse of [tokenize, lex]) {
    const { cmd, at, args } = commandOf(parse('2>/dev/null > out cd ..').segs[0]);
    assert.deepEqual([cmd, at, args], ['cd', 3, ['..']]);
  }
  assert.equal(commandOf(['<', 'script.sh']).cmd, undefined, 'a redirection alone runs no command');
});

test('N5: an unquoted variable alone where the rm options stand is judged', () => {
  assertAllAsk([
    `F="-rf /"; ${RM} $F`, // the value holds options and a target: bash splits it
    `F="-rf ~"; ${RM} $F`,
    `${RM} $F`, // unknown value
    `${RM} -f $F`,
    `${RM} \${F}`,
    `printf -v F %s "-rf $HOME"; ${RM} $F`,
    `${RM} "$F" $F`, // one of the two is unquoted
    `F="-rf /"; ${RM} -- $F x`.replace('-- $F x', '$F x'),
  ]);
  assertAllSilent([
    `F="-rf dist"; ${RM} $F`, // the same delete as `rm -rf dist`
    `${RM} "$F"`, // quoted alone: one word, a file name
    `${RM} -- $F`, // after `--` no word is an option
    `F=old.log; ${RM} $F`,
    `${RM} -f build/out.log`,
  ]);
});

test('G8: after cd X || exit the folder is X', () => {
  assertAllSilent([
    `cd src || exit 1; ${RM} -rf ../gen`,
    `cd src || exit; ${RM} -rf ../gen`,
    `cd src || exit 1\n${RM} -rf ../gen`,
    `cd src || exit 1 && ${RM} -rf ../gen`,
    `cd src || exit 1; echo hi; ${RM} -rf ../gen`,
    `cd ${PROJECT}/src || exit 2; ${RM} -rf ../gen`,
  ]);
  assertAllAsk([
    `cd ../x || exit 1; ${RM} -rf gen`, // X itself is outside the project
    `cd src || exit 1; cd ..; ${RM} -rf ../gen`, // a later cd moves on
    `cd src || exit 1 | cat; ${RM} -rf ../gen`, // exit in a pipeline ends only a subshell
    `cd src || exit 1 & ${RM} -rf ../gen`,
    `(cd src || exit 1); ${RM} -rf ../gen`, // the exit ends the subshell only
    `{ cd src || exit 1; } | cat; ${RM} -rf ../gen`,
    `cd src || return; ${RM} -rf ../gen`, // return at the top level is an error the Bash tool goes on after
    `cd src || return 1; ${RM} -rf ../gen`,
    `true || cd src || exit 1; ${RM} -rf ../gen`, // the cd may not have run
    `cd src || echo no; ${RM} -rf ../gen`,
    `cd src && make || exit 1; ${RM} -rf ../gen`,
    `cd src || exit "$X"; ${RM} -rf ../gen`,
    `cd src || kill -9 $$; ${RM} -rf ../gen`,
    `exit() { :; }; cd src || exit 1; ${RM} -rf ../gen`, // exit is replaced
    `function exit { :; }; cd src || exit 1; ${RM} -rf ../gen`,
    `alias exit=true; cd src || exit 1; ${RM} -rf ../gen`,
    `source ./env.sh; cd src || exit 1; ${RM} -rf ../gen`,
    `for d in a b; do cd src || exit 1; done; ${RM} -rf ../gen`,
    `case $1 in a) cd src || exit 1;; esac; ${RM} -rf ../gen`,
    `cd src || exit 1 || true; ${RM} -rf /etc/x`,
  ]);
});

test('N6: a zsh glob qualifier glued to a glob is judged as that glob', () => {
  assertAllSilent([`${RM} -rf src/*(.)`, `${RM} -rf src/*(/)`, `${RM} -rf src/*(@)`, `${RM} -rf src/*(.N)`]);
  assertAllAsk([
    `${RM} -rf *(.)`, // the glob alone empties the project folder
    `${RM} -rf ../*(.)`,
    `${RM} -rf /etc/*(.)`,
    `${RM} -rf src/ (/)`, // apart from the word: a group naming /
    `${RM} -rf src/* (/)`,
    `${RM} -rf src/*(.|/)`, // more than one branch is a group of names
    `${RM} -rf src/*(..)`,
    `${RM} -rf src/*(*)`,
    `${RM} -rf 'src/*'(.)`, // quoted: not read as a qualifier
    `${RM} -rf ./(*)`,
    `${RM} -rf (*|.*)`,
  ]);
});

test('N8: a comment line between && and the next command keeps the chain, in both parsers', () => {
  for (const parse of [tokenize, lex]) {
    const joins = parse(`cd src && # go\n${RM} -rf ../gen`).segs.map((seg) => seg.joinedBy);
    assert.deepEqual(joins, ['', '&&\n']);
    assert.deepEqual(parse(`cd src &&\n# go\n${RM} -rf ../gen`).segs.map((seg) => seg.joinedBy), ['', '&&\n\n']);
  }
  assertAllSilent([`cd src && # go\n${RM} -rf ../gen`, `cd src &&\n# go\n${RM} -rf ../gen`, `cd src &&\n  # go\n  ${RM} -rf ../gen`]);
  assertAllAsk([
    `cd .. && # go\n${RM} -rf proj`,
    `cd src; # go\n${RM} -rf ../gen`, // after `;` the cd may have failed: unchanged
    `cd src && echo a#b\n${RM} -rf ../x/..`.replace('../x/..', '/etc/x'), // a `#` inside a word is no comment
    `cd src && # go\n${RM} -rf /etc/x`,
  ]);
});

test('X3 heredoc: after a cd the body of a heredoc a program runs is read for deletes', () => {
  assertAllAsk([
    `cd .. && ssh host <<EOF\n${RM} -rf proj\nEOF`,
    `cd .. && xargs <<EOF\n${RM} -rf proj\nEOF`,
    `cd .. && ssh host <<'EOF'\nfind . -delete\nEOF`,
    `cd .. && bash <<EOF\n${RM} -rf proj\nEOF`,
  ]);
  assertAllSilent([
    `cd .. && cat <<EOF\n${RM} -rf proj\nEOF`, // cat only prints its body
    `cd .. && cat <<'EOF'\n${RM} -rf proj\nEOF`,
    `cd .. && git commit -F - <<EOF\n${RM} -rf proj\nEOF`,
    `ssh host <<EOF\n${RM} -rf proj\nEOF`.replace('ssh host', 'cat'), // no cd: nothing to follow
  ]);
});

test('F1 to F3: hostile names, empty and huge text are asked or silent without a crash', () => {
  assertAllAsk([`F="-rf /"; ${RM} $F`.replace('/', '"a b"'), `${RM} -rf src/*(.)\n${RM} -rf "x y"/../..`, `cd "a b" || exit 1; ${RM} -rf '../a b'/../..`]);
  assert.ok(silent(''), 'empty text runs nothing');
  const huge = `cd src || exit 1; ${RM} -rf ../gen; `.repeat(30000);
  const decision = decide(huge, ctx);
  assert.equal(decision.ask, true, 'a line over the size cap asks');
  assert.ok(asks(`F="${'x'.repeat(100000)}"; ${RM} $F`));
});

// Fix round (R1 to R4): each case below was let through by the first build of these forms.
test('R1 G8: cd X || exit counts only when the cd surely runs, at the top level after the line start, ; or a newline', () => {
  assertAllAsk([
    `if false; then cd src || exit 1; fi; ${RM} -rf ../gen`,
    `if [ -d nope ]; then cd src||exit 1; fi\n${RM} -rf ../gen`,
    `if true; then :; else cd src||exit 1; fi; ${RM} -rf ../gen`,
    `false && if true; then cd src||exit 1; fi; ${RM} -rf ../gen`,
    `if true; then :; elif true; then cd src || exit 1; fi; ${RM} -rf ../gen`,
    `true && cd src || exit 1; ${RM} -rf ../gen`, // a conditional join before the cd
    `while true; do cd src || exit 1; break; done; ${RM} -rf ../gen`,
    `f() { cd src || exit 1; }; ${RM} -rf ../gen`, // a function body may never be called
  ]);
  assertAllSilent([`if true; then :; fi; cd src || exit 1; ${RM} -rf ../gen`]); // after `fi` the cd is at the top level again
});

test('R2 N6: a qualifier counts as glued only at the rm word itself, not where the same text stands elsewhere on the line', () => {
  assertAllAsk([
    `cd .. && ${RM} -rf proj/gen/* (N) # proj/gen/*(N)`,
    `${RM} -rf src/* (/); echo src/*(/)`,
    `${RM} -rf src/\\* (/); echo src/*(/)`,
  ]);
  assertAllSilent([`${RM} -rf src/*(.) # src/* (.)`]);
  for (const parse of [tokenize, lex]) {
    assert.deepEqual(parse(`${RM} -rf src/*(.) x`).segs.map((seg) => seg.gluedTo ?? null), [null, 'src/*', null]);
    assert.deepEqual(parse(`${RM} -rf src/* (.)`).segs.map((seg) => seg.gluedTo ?? null), [null, null]);
  }
});

test('R3 G2: every redirection operator in front of cd is skipped, in both parsers', () => {
  const operators = ['<<< x', '<<<x', '<> f', '>& f', '>| f', '>! f', '>>| f', '&>| f', '<& 0', '{fd}>f', '2>&1', '2>&-', '&>f', '&>>f'];
  assertAllAsk(operators.map((operator) => `${operator} cd .. && ${RM} -rf proj`));
  for (const parse of [tokenize, lex]) {
    for (const operator of ['<<< x', '>| f', '{fd}>f', '<> f']) assert.equal(commandOf(parse(`${operator} cd ..`).segs[0]).cmd, 'cd', operator);
  }
  assertAllAsk([`${RM} -rf '{fd}>x/../../..'`]); // quoted: a name, not a redirection
  assertAllSilent([`>| out.log cd src && ${RM} -rf gen`]);
});

test('R4 N5: a line that changes IFS, or an option word from a variable holding more than option letters, asks', () => {
  assertAllAsk([
    `IFS=,; F=-rf,/Users; ${RM} $F`,
    `export IFS=,; F=-rf,/Users; ${RM} $F`,
    `read IFS <<< ,; F=-rf,/Users; ${RM} $F`,
    `IFS=,; D=/,-delete; find $D`,
    `IFS=,; X=push,--force; git $X`,
    `F=-rf,/Users; ${RM} $F`,
    `F="-rf,/Users x"; ${RM} $F`,
    `D="/ -delete"; find $D`, // bash splits it at the blank: -delete is an option of find
    `D="/ -exec ${RM} -rf {} +"; find $D`,
  ]);
  assertAllSilent([`IFS=, read -r a b <<< "$x"; echo "$a"`, `IFS=,; ${RM} -rf dist`, `F=-rf; ${RM} $F dist`]);
});

test('R3 sibling: every output operator is read as a write where the guard reads redirection targets', () => {
  assertAllAsk([
    'echo x >| /dev/disk2',
    'echo x >! /dev/disk2',
    'echo x >&/dev/disk2',
    'echo x {fd}>/dev/disk2',
    'gh ssh-key add >| x.pub ~/.ssh/id_rsa', // the key file is the private key, not the redirection target
    'echo x >| ~/.claude/private/prod-hosts',
  ]);
  assertAllSilent(['echo hi 2>&1', 'echo hi >/dev/null', 'echo hi >&2']);
});
