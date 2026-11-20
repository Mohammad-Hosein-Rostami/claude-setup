// Tests for the folders the guard judges a command in after a `cd` (lib/cd-folder.mjs). It used to follow every `cd` it read, whatever
// joined it to the next command: `(cd src); rm -rf ../x` was judged from `src`, where `../x` is inside the project, while the shell
// runs the rm from the project root and deletes its neighbour. Now a `cd` is believed alone only inside its own `&&` chain. Where it may
// or may not have taken effect (after `;`, a newline, `||`, `&`, a pipe, the end of a group or compound) the command is judged from the
// folder before the `cd` AND the one after, and runs unasked only when it is fine from both. More than MAX_POSSIBLE_FOLDERS, a target
// the shell resolves from state the guard lacks (`+N`, a bare drive, CDPATH, autocd, cdable_vars), eval/source and a relative `cd` in
// a loop or function body make the folder unknown: a relative `rm -r` target asks, an absolute one is judged.
// Both parsers must record the same joins. Command strings are only passed to decide(); nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { MAX_POSSIBLE_FOLDERS } from '../home/hooks/lib/cd-folder.mjs';
import { lex, tokenize } from '../home/hooks/lib/shell-words.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const RM = 'rm'; // kept apart so this file's own text never reads as a command
const atRoot = { cwd: PROJECT, project: PROJECT };
const OUTSIDE = /^DESTRUCTIVE: rm -r outside the project \(/;
const WHOLE_FOLDER = /^DESTRUCTIVE: rm -r that empties a whole folder \(/;

const firstReason = (command, ctx = atRoot) => decide(command, ctx).reasons?.[0] ?? 'allowed';

/** Runs the body with CDPATH unset, whatever the machine has. */
function withoutCdpath(body) {
  const before = process.env.CDPATH;
  delete process.env.CDPATH;
  try {
    body();
  } finally {
    if (before !== undefined) process.env.CDPATH = before;
  }
}

// the reviewer's nine forms (R2-20..28): in bash and zsh each runs the rm from the project root, where `../x` is the project's neighbour
const CD_NOT_IN_THE_CHAIN = [
  `(cd src); ${RM} -rf ../x`,
  `(cd src && make) && ${RM} -rf ../out`,
  `cd src | cat; ${RM} -rf ../x`,
  `cd src & ${RM} -rf ../x`,
  `true || cd src; ${RM} -rf ../x`,
  `false && cd src; ${RM} -rf ../x`,
  `if false; then cd src; fi; ${RM} -rf ../x`,
  `cd no-such-dir; ${RM} -rf ../x`,
  `f() { cd src; }; ${RM} -rf ../x`,
];
// the target leaves the project from one of the folders the line may be in
const OUTSIDE_FROM_ONE_FOLDER = [
  `cd packages/app; ${RM} -rf ../../node_modules`, // a failed cd: two levels above the project
  `cd packages/app\n${RM} -rf ../../node_modules`,
  `cd src; cd .. && ${RM} -rf dist`, // when the first cd failed, the second one leaves the project
  `cd packages/app && npm test; cd ../.. && ${RM} -rf coverage`, // the same shape with a longer path
  `cd src || ${RM} -rf ../x`,
  `cd src && make || ${RM} -rf ../x`,
  `{ cd src; }; ${RM} -rf ../x`,
  `case $1 in a) cd src;; esac; ${RM} -rf ../x`,
  `X=$(cd src && pwd); ${RM} -rf ../x`,
  `cd src | cat && ${RM} -rf ../x`, // the pipeline holds the cd: it ran in a subshell
  `cd src |& cat && ${RM} -rf ../x`,
  `make | cd src && ${RM} -rf ../x`,
  `cd src && make | cd sub && ${RM} -rf ../../x`,
  `! cd src && ${RM} -rf ../x`, // the rm runs when the cd FAILED
  `if ! cd src; then ${RM} -rf ../x; fi`,
  `sudo cd src && ${RM} -rf ../x`, // a cd behind a wrapper does not move this shell
  `env FOO=1 cd src && ${RM} -rf ../x`,
];
// a relative cd that may run again, or more folders than the guard follows: unknown, so a relative target asks
const FOLDER_UNKNOWN = [
  `for d in a b c; do cd .. && ${RM} -rf x; done`,
  `while true; do make; cd .. && ${RM} -rf x; done`,
  // the rm comes after the loop: one `cd ..` of the loop is harmless, but the loop may run it again and again
  `for d in a b; do cd ..; done; ${RM} -rf proj/x`,
  `while true; do cd ..; done; ${RM} -rf proj/x`,
  `until false; do cd ..; done; ${RM} -rf proj/x`,
  `function f { cd src; }; ${RM} -rf ../x`,
  `f() { cd ..; }; f; f; ${RM} -rf x`,
  // one `cd ..` of the body is harmless, but each call of the function moves on from where the last stopped
  `f() { cd ..; }; f; f; ${RM} -rf proj/x`,
  `function f { cd ..; }; f; f; ${RM} -rf proj/x`,
  `source ./env.sh; cd ${PROJECT}/src && make; ${RM} -rf gen`, // known inside the chain of the absolute cd only
  // a cd the guard cannot read at all is final: an absolute cd after it does not make the folder known (found by the probe against main)
  `cd "$SOMEWHERE"; cd ${PROJECT}/src && ${RM} -rf ../gen`,
  `cd - && cd /tmp && ${RM} -rf build`,
  `cd ~user && cd ${PROJECT} && ${RM} -rf dist`,
  `popd; cd ${PROJECT} && ${RM} -rf dist`,
  `(cd "$X"); cd ${PROJECT} && ${RM} -rf dist`,
];
const UNREAD_TEXT = [`eval cd ..; ${RM} -rf proj`, `eval "cd .." && ${RM} -rf proj`, `source ./env.sh && ${RM} -rf proj`, `. ./env.sh; ${RM} -rf proj`];
// F5, F8, F9: the shell resolves these from state the guard does not have
const UNKNOWN_TARGETS = [
  `pushd ~ && pushd ${PROJECT} && pushd +1 && ${RM} -rf Documents`,
  `pushd ~ && pushd ${PROJECT} && cd +1 && ${RM} -rf Documents`,
  `cd C: && ${RM} -rf Users`,
  `CDPATH=/Users cd pejvak && ${RM} -rf Documents`,
  `export CDPATH=~; cd Documents && ${RM} -rf Work`,
  `CDPATH=/etc; cd src && ${RM} -rf gen`,
  `cdpath=(~ /); cd src && ${RM} -rf gen`,
  `setopt autocd; ..; ${RM} -rf proj`,
  `setopt AUTO_CD && src && ${RM} -rf gen`,
  `shopt -s cdable_vars; X=/; cd X; ${RM} -rf etc`,
  `shopt -s cdable_vars && cd X && ${RM} -rf etc`,
];
const STILL_SILENT = [
  `cd packages/app && ${RM} -rf ../../node_modules`,
  `cd src && ${RM} -rf gen && ${RM} -rf gen2`,
  `make; cd src && ${RM} -rf ../dist`,
  `make && cd src && ${RM} -rf ../dist`,
  `cd src &&\n${RM} -rf ../dist`,
  `cd src; ${RM} -rf ${PROJECT}/dist`, // an absolute target is judged whatever the folder
  `(cd src); ${RM} -rf /tmp/x/y`,
  `${RM} -rf dist; cd src`,
  `${RM} -rf dist && (cd src && make)`,
  `(cd src); ls`,
  `cd src; npm test`,
  `source ./env.sh && npm test`,
  `cd ./src && ${RM} -rf gen`,
];
// the ordinary lines the "unknown after any other join" rule made ask: the target is inside the project from every folder the line may be in
const FINE_FROM_EVERY_FOLDER = [
  `cd packages/app; ${RM} -rf dist`,
  `cd packages/app\n${RM} -rf dist`,
  `cd packages/app; find . -name '*.orig' -delete`,
  `cd src || exit 1; ${RM} -rf gen`,
  `cd a; cd b; ${RM} -rf x`, // four folders: the cap
  `for d in a b; do cd ${PROJECT}/src && ${RM} -rf gen; done; ${RM} -rf dist`,
];
// a cd is believed inside its own chain in a group or an `if` as well
const CHAIN_IN_A_GROUP = [
  `(cd packages/app && ${RM} -rf dist)`,
  `(cd src && ${RM} -rf ../dist)`,
  `{ cd src && ${RM} -rf ../x; }`,
  `if [ -d packages/app ]; then cd packages/app && ${RM} -rf ../../dist; fi`,
];
const PIPELINE_IN_THE_CHAIN = [`cd packages/app && npm run build | tail -5 && ${RM} -rf ../../dist`, `cd src && make 2>&1 |& tee log && ${RM} -rf ../dist`];
// an absolute cd is known whatever came before
const ABSOLUTE_CD = [
  `cd /tmp/x && ${RM} -rf y; cd ${PROJECT} && ${RM} -rf dist`,
  `source ./env.sh; cd ${PROJECT}/src && ${RM} -rf gen`, // a relative target: it asks while the folder is unknown
  `for d in a b; do cd ${PROJECT}/src && ${RM} -rf ../gen; done`,
  `for f in a b; do echo "$f"; done; cd src && ${RM} -rf ../gen`, // the loop ended at its `done`: a relative cd is followed again
];

test('the nine forms whose cd does not move the rm still ask: the target is judged from the folder before the cd as well', () => {
  for (const command of [...CD_NOT_IN_THE_CHAIN, ...OUTSIDE_FROM_ONE_FOLDER]) assert.match(firstReason(command), OUTSIDE, command);
});

test('a relative cd in a loop or a function body, and a cd chain that leaves more than the cap of folders open, make the folder unknown', () => {
  for (const command of FOLDER_UNKNOWN) assert.match(firstReason(command), OUTSIDE, command);
  assert.equal(MAX_POSSIBLE_FOLDERS, 4);
  withoutCdpath(() => assert.match(firstReason(`cd a; cd b; cd c; ${RM} -rf x`), OUTSIDE, 'eight folders'));
});

test('after eval, source or `.` the folder is unknown: the text they run may hold a cd', () => {
  for (const command of UNREAD_TEXT) assert.ok(decide(command, atRoot).reasons?.some((reason) => OUTSIDE.test(reason)), command);
});

test('a cd target the shell resolves from the folder stack, a drive, CDPATH, autocd or cdable_vars makes the folder unknown', () => {
  for (const command of UNKNOWN_TARGETS) assert.match(firstReason(command), OUTSIDE, command);
});

test('CDPATH in the environment makes every relative cd unknown, and only a relative one', () => {
  const command = `cd src && ${RM} -rf gen`;
  const absolute = `cd ${PROJECT}/src && ${RM} -rf gen`;
  const before = process.env.CDPATH;
  try {
    delete process.env.CDPATH;
    assert.equal(firstReason(command), 'allowed');
    process.env.CDPATH = '/Users';
    assert.match(firstReason(command), OUTSIDE);
    assert.equal(firstReason(absolute), 'allowed');
    assert.equal(firstReason(`cd ../proj/src && ${RM} -rf gen`), firstReason(command), 'the simple rule: any relative target');
  } finally {
    if (before === undefined) delete process.env.CDPATH;
    else process.env.CDPATH = before;
  }
});

test('a cd inside its own && chain is followed as before, and an absolute target never needs the folder', () => {
  withoutCdpath(() => {
    for (const command of STILL_SILENT) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
    assert.match(firstReason(`cd .. && ${RM} -rf x`), OUTSIDE, 'followed: the parent of the project');
    assert.match(firstReason(`cd src; ${RM} -rf /etc/x`), OUTSIDE);
  });
});

test('a target that is fine from the folder before the cd and from the one after runs unasked', () => {
  withoutCdpath(() => {
    for (const command of FINE_FROM_EVERY_FOLDER) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
  });
});

test('a cd chain inside a group or an if is believed within the chain, and a pipeline between two && keeps the chain', () => {
  withoutCdpath(() => {
    for (const command of [...CHAIN_IN_A_GROUP, ...PIPELINE_IN_THE_CHAIN]) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
    // the rm behind the pipe runs in `src`, so its target is inside the project; reading paths from stdin still asks by its own rule
    const piped = decide(`cd src && ls | xargs ${RM} -rf ../x`, atRoot);
    assert.deepEqual([piped.ask, piped.reasons.some((reason) => OUTSIDE.test(reason))], [true, false], piped.reason);
  });
});

test('an absolute cd makes the folder known again inside its chain, also after an unknown one and inside a loop', () => {
  withoutCdpath(() => {
    for (const command of ABSOLUTE_CD) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
  });
});

test('a bare glob asks when it would empty any folder the line may be in', () => {
  for (const command of [`cd src; ${RM} -rf *`, `cd src\n${RM} -rf ./*`, `(cd src); ${RM} -rf .* *`, `cd dist || true; ${RM} -rf *`]) assert.match(firstReason(command), WHOLE_FOLDER, command);
});

// found by the differential probe against the tip before this round: with the folder unknown these stopped asking
test('an absolute target that names a folder the line may be in, or a bare glob of it, still asks as a whole folder', () => {
  const inSrc = { cwd: resolve(PROJECT, 'src'), project: PROJECT };
  const src = resolve(PROJECT, 'src');
  const WHERE_A_CD_MAY_HAVE_LED = [`cd src; ${RM} -rf ${src}`, `(cd src); (${RM} -rf -- ${src})`, `cd src\n${RM} -rf ${src}/*`, `true || cd src; ${RM} -rf ${src}/.*`,
    `(cd src) && ${RM} -rf ${src}/[a-z]*`, `cd src | cat; { ${RM} -R ${src}/*; } | tee log`, `cd +0 && ${RM} -rf ${PROJECT}/*`,
    `cd src; bash -c '${RM} -fr ${src}'`, `(cd src) && bash -c '${RM} -Rf ${src}/'`, `(cd src); sh -c "bash -c '${RM} -rf ${src}/*'"`, // a script run by the line may be in the same folders
    `cd src || cd lib; eval "$X"; ${RM} -rf ${PROJECT}/lib/*`]; // unknown after the eval: every folder the line was seen in is held against the target
  for (const command of WHERE_A_CD_MAY_HAVE_LED) assert.ok(decide(command, atRoot).reasons?.some((reason) => WHOLE_FOLDER.test(reason)), command);
  // a cd in a subshell does not move the line: the folder it started in is held against the target as well
  for (const command of [`(cd ..); ${RM} -rf ${src}/*`, `cd .. | cat; ${RM} -rf ${src}`]) assert.match(firstReason(command, inSrc), WHOLE_FOLDER, command);
  assert.deepEqual(decide(`cd src; ${RM} -rf ${src}/gen`, atRoot), { allow: true }, 'a sub-folder of it is an ordinary target');
});

test('both parsers record the operators in front of each segment, the same way', () => {
  const joins = (parse, line) => parse(line).segs.map((seg) => seg.joinedBy);
  for (const parse of [tokenize, lex]) assert.equal(parse('a b && c d').segs[1].join(' '), 'c d', 'the flag does not hide Array.join on a segment');
  assert.deepEqual(joins(tokenize, '(cd src && make) && x -r ../out; ls |\n wc & y || z'), ['(', '&&', ')&&', ';', '|\n', '&', '||']);
  const LINES = ['a', 'a && b', 'a &&\nb', 'a; b\nc', '(a; b) || c', 'a | b |& c', 'f() { a; }; b', 'a & b', 'x=$(a && b); c', 'echo $(a) b; c', 'a `b` c && d', 'if a; then b; fi && c', 'a <<EOF\nbody\nEOF\nb && c'];
  for (const line of LINES) assert.deepEqual(joins(lex, line), joins(tokenize, line), line);
});
