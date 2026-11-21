// Tests for a recursive rm that empties a whole folder from inside the project: a bare glob (`*`, `./*`, `.*`, `?`) of the working
// directory or the project root, or the working directory itself, asks like `rm -rf /` does (DESTRUCTIVE), wherever the shell stands.
// So does a bare glob below a bare glob (`./**/*`, `*/*`): it empties every sub-folder, and with globstar the whole tree.
// A glob of a sub-folder (`src/*`), a named target and a glob with a name part (`*.log`) stay silent. Command strings are only passed to
// decide(); nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const RM = 'rm'; // kept apart so this file's own text never reads as a command
const atRoot = { cwd: PROJECT, project: PROJECT };
const inSrc = { cwd: resolve(PROJECT, 'src'), project: PROJECT };

/** @returns {boolean} true when the guard asks with a DESTRUCTIVE reason */
const asksDestructive = (command, ctx) => {
  const result = decide(command, ctx);
  return result.ask === true && result.reasons.some((reason) => reason.startsWith('DESTRUCTIVE:'));
};

const ASK_AT_ROOT = [
  `${RM} -rf *`,
  `${RM} -rf ./*`,
  `${RM} -rf .*`,
  `${RM} -rf -- *`,
  `${RM} -rf ?`,
  `${RM} -rf **`,
  `${RM} -rf */`,
  `${RM} -rf [a-z]*`,
  `${RM} -rf .[!.]*`,
  `${RM} -rf * .*`,
  `${RM} -rf dist *`,
  `${RM} -rf "$PWD"/*`,
  `${RM} -rf $PWD/*`,
  `${RM} -rf ${PROJECT}/*`,
  `${RM} -r *`,
  `${RM} -R ./*`,
  `${RM} --recursive *`,
  `sudo ${RM} -rf *`,
  `cd src && ${RM} -rf *`,
  `cd /tmp && ${RM} -rf *`,
];
const ASK_GLOB_BELOW_GLOB = [
  `${RM} -rf ./**/*`,
  `${RM} -rf **/*`,
  `${RM} -rf ./**`,
  `${RM} -rf */*`,
  `${RM} -rf ./*/*`,
  `${RM} -rf **/.*`,
  `${RM} -rf **/*/`,
  `${RM} -rf **//*`,
  `${RM} -rf */*/*`,
  `${RM} -rf "$PWD"/**/*`,
  `${RM} -rf ${PROJECT}/**/*`,
  `${RM} -rf {*,.*}/*`,
  `${RM} -rf [a-z]*/?`,
  `cd src && ${RM} -rf **/*`,
];
const ASK_GLOB_BELOW_GLOB_IN_SUBFOLDER = [`${RM} -rf **/*`, `${RM} -rf ./**/*`, `${RM} -rf ../**/*`, `${RM} -rf ../*/*`];
const ASK_UNKNOWN_DIRECTORY = [`cd "$SOMEWHERE" && ${RM} -rf *`, `cd "$SOMEWHERE" && ${RM} -rf ./**/*`, `cd "$SOMEWHERE" && ${RM} -rf ./*`];
// after a cd the guard cannot follow, an absolute target is still judged against the project root, home and the roots
const ASK_UNKNOWN_DIRECTORY_ABSOLUTE = [
  `cd "$SOMEWHERE" && ${RM} -rf ${PROJECT}/*`,
  `cd "$SOMEWHERE" && ${RM} -rf "$CLAUDE_PROJECT_DIR"/*`,
  `cd "$SOMEWHERE" && ${RM} -rf ${PROJECT}/**/*`,
  `cd "$SOMEWHERE"; ${RM} -rf ${PROJECT}/.*`,
  `cd - && ${RM} -rf ${PROJECT}/*`,
  `popd; ${RM} -rf ${PROJECT}/*`,
  `cd "$SOMEWHERE" && ${RM} -rf ${PROJECT}/src ${PROJECT}/./*`,
];
const SILENT_UNKNOWN_DIRECTORY = [`cd "$SOMEWHERE" && ${RM} -rf ${PROJECT}/src/*`, `cd "$SOMEWHERE" && ${RM} -rf ${PROJECT}/dist`, `popd; ${RM} -rf /tmp/x/*`];
const ASK_IN_SUBFOLDER = [`${RM} -rf *`, `${RM} -rf .*`, `${RM} -rf "$PWD"`, `${RM} -rf ../*`];
const ALREADY_ASKED = [`${RM} -rf /`, `${RM} -rf /*`, `${RM} -rf ~`, `${RM} -rf ~/*`, `cd ~ && ${RM} -rf *`];
// every bracket form is a glob: POSIX classes, a `]` in first place, negation, equivalence classes and collating symbols
const ASK_BRACKET_FORMS = [
  `${RM} -rf [[:alnum:]]*`,
  `${RM} -rf [[:print:]]*`,
  `${RM} -rf [![:space:]]*`,
  `${RM} -rf *[[:alnum:]]`,
  `${RM} -rf [[:alpha:][:digit:]]*`,
  `${RM} -rf src [[:alnum:]]* .[[:alnum:]]*`,
  `${RM} -rf []a]*`,
  `${RM} -rf [!]]*`,
  `${RM} -rf [^]a-z]?`,
  `${RM} -rf [[=a=]]*`,
  `${RM} -rf [[.hyphen.]]*`,
  `${RM} -rf [a[:digit:]_]*`,
  `${RM} -rf ./[[:upper:]]*/[[:lower:]]*`,
  `${RM} -rf [[:x]*`, // no class after all: a set of `[`, `:` and `x`
  `${RM} -rf [[:alpha:]][[:x]*`,
];
const SILENT_BRACKET_FORMS = [
  `${RM} -rf [[:alnum:]]*.log`,
  `${RM} -rf build[[:digit:]]`,
  `${RM} -rf [[:alnum:]`, // the set never closes: bash reads a plain name
  `${RM} -rf [abc`,
  `${RM} -rf *[`,
  `${RM} -rf src/[[:alnum:]]*`,
  `${RM} -rf [[:alnum:]]*/dist`,
];
// a `.` part changes nothing: these are `*/*`, `*` and `**/**` written another way
const ASK_DOT_PARTS = [
  `${RM} -rf ./*/./*`,
  `${RM} -rf */./*`,
  `${RM} -rf "$PWD"/*/./*`,
  `${RM} -rf */.`,
  `${RM} -rf */./`,
  `${RM} -rf .//./*`,
  `${RM} -rf **/./**`,
  `${RM} -rf *//.//*`,
  `${RM} -rf ././*/././.*`,
  `${RM} -rf ${PROJECT}/./*/./*`,
];
const SILENT_DOT_PARTS = [`${RM} -rf src/./*`, `${RM} -rf ./src/./*/./*`, `${RM} -rf */./dist`, `${RM} -rf src/.`, `${RM} -rf ./src/./`, `${RM} -rf .`, `${RM} -rf ./`]; // `.` and `./`: rm refuses them (r9 F15)
// the shared temp roots hold other sessions' work (every scratchpad): a bare glob of one empties them all
const ASK_TEMP_ROOT = [`${RM} -rf /tmp/*`, `${RM} -rf /private/tmp/*`, `${RM} -rf "$TMPDIR"/*`, `${RM} -rf $TMPDIR/.*`, `${RM} -rf /tmp/**/*`, `${RM} -rf /tmp/./*`];
const SILENT = [
  `${RM} -rf src/*`,
  `${RM} -rf ./dist/*`,
  `${RM} -rf *.log`,
  `${RM} -rf {a,b}*`,
  `${RM} -rf node_modules`,
  `${RM} -rf dist build`,
  `${RM} -rf /tmp/x/*`,
  `D=$(mktemp -d) && ${RM} -rf $D/*`,
  `${RM} -f *`,
  `${RM} -rf src/**/*`,
  `${RM} -rf src/*/*`,
  `${RM} -rf **/node_modules`,
  `${RM} -rf */dist`,
  `${RM} -rf **/*.log`,
  `${RM} -rf */*.log`,
  `${RM} -rf /tmp/x/**/*`,
  `${RM} -f **/*`,
];

test('a recursive rm of a bare glob in the working directory or the project root asks as destructive', () => {
  for (const command of ASK_AT_ROOT) assert.ok(asksDestructive(command, atRoot), command);
});

test('from a sub-folder, a bare glob, the working directory itself and the glob of the project root ask', () => {
  for (const command of ASK_IN_SUBFOLDER) assert.ok(asksDestructive(command, inSrc), command);
});

test('a bare glob below a bare glob of the working directory or the project root asks: it empties every sub-folder', () => {
  for (const command of ASK_GLOB_BELOW_GLOB) assert.ok(asksDestructive(command, atRoot), command);
  for (const command of ASK_GLOB_BELOW_GLOB_IN_SUBFOLDER) assert.ok(asksDestructive(command, inSrc), command);
});

test('a bare glob after a cd that cannot be resolved still asks, as an unknown target', () => {
  for (const command of ASK_UNKNOWN_DIRECTORY) assert.ok(asksDestructive(command, atRoot), command);
});

test('after a cd that cannot be resolved an absolute bare glob of the project root still asks, and an absolute sub-folder stays silent', () => {
  for (const command of ASK_UNKNOWN_DIRECTORY_ABSOLUTE) {
    const result = decide(command, atRoot);
    assert.match(result.reasons?.[0] ?? 'allowed', /^DESTRUCTIVE: rm -r that empties a whole folder \(/, command);
  }
  for (const command of SILENT_UNKNOWN_DIRECTORY) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
});

test('root, home and the project root keep asking as before', () => {
  for (const command of ALREADY_ASKED) assert.ok(asksDestructive(command, atRoot), command);
});

test('POSIX classes and every other bracket form count as a bare glob', () => {
  for (const command of ASK_BRACKET_FORMS) assert.ok(asksDestructive(command, atRoot), command);
  for (const command of SILENT_BRACKET_FORMS) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
});

test('a . part or a doubled slash between bare globs changes nothing: the target is normalised before the check', () => {
  for (const command of ASK_DOT_PARTS) assert.ok(asksDestructive(command, atRoot), command);
  for (const command of SILENT_DOT_PARTS) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
});

test('a bare glob of a temp root asks; a folder inside one stays silent', () => {
  for (const command of ASK_TEMP_ROOT) assert.ok(asksDestructive(command, atRoot), command);
  for (const command of [`${RM} -rf /tmp/x/*`, `${RM} -rf "$TMPDIR"/build/*`, `${RM} -rf /tmp/x`]) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
});

test('a glob of a sub-folder, a glob with a name part, named targets and a non-recursive rm stay silent', () => {
  for (const command of SILENT) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
});
