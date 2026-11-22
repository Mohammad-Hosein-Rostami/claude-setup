// Tests that `$PWD`, `${PWD}` and `$(pwd)` in an `rm -r` target follow the folder the line's `cd`s led to. They used to keep the folder
// the line started in, so `cd .. && rm -rf "$PWD"/*` from a sub-folder was judged as a glob of the sub-folder and allowed.
// After a cd the guard cannot follow, `$PWD` is unknown and asks. The value the line started with is judged as well, so no ask is lost.
// Command strings are only passed to decide(); nothing is executed.
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
const asksDestructive = (command, ctx) => decide(command, ctx).reasons?.some((reason) => reason.startsWith('DESTRUCTIVE:')) === true;

const ASK_FROM_SRC = [
  `cd .. && ${RM} -rf "$PWD"`, // the project root itself
  `cd .. && ${RM} -rf "$PWD"/*`,
  `cd .. && ${RM} -rf "\${PWD}"/*`,
  `cd .. && ${RM} -rf $(pwd)/*`,
  `cd .. && ${RM} -rf $(pwd)`,
  `cd .. && ${RM} -rf \`pwd\`/.*`,
  `cd ${PROJECT} && ${RM} -rf "$PWD"/*`,
  `cd "$(git rev-parse --show-toplevel)" && ${RM} -rf "$PWD"/*`,
  `cd ../.. && ${RM} -rf "$PWD"/proj`, // the project, named from its parent
  `cd ../.. && ${RM} -rf "\${PWD}"/x`,
  `cd ~ && ${RM} -rf "$PWD"/*`,
  `cd / && ${RM} -rf "$PWD"/*`,
  `cd / && ${RM} -rf "$PWD"/etc`,
  `pushd .. && ${RM} -rf "$PWD"/*`,
  `cd ..; cd ..; ${RM} -rf "$PWD"/other`,
];
const ASK_UNKNOWN_FOLDER = [
  `cd "$BUILD" && ${RM} -rf "$PWD"/*`,
  `cd "$BUILD" && ${RM} -rf "$PWD"/x`,
  `cd "$BUILD" && ${RM} -rf "\${PWD}"/x`,
  `cd - && ${RM} -rf "$(pwd)"/x`,
  `popd; ${RM} -rf $PWD/x`,
];
// a cd whose own target reads $PWD after the folder moved: the guard does not guess, the folder is unknown from there on
const ASK_CD_THROUGH_PWD = [`cd ../.. && cd "$PWD" && ${RM} -rf proj`, `cd .. && cd "$PWD"/.. && ${RM} -rf proj`, `cd .. && cd "$(pwd)" && ${RM} -rf src/..`];
// asked before this change, for the folder the line started in: these asks are kept
const ASK_KEPT = [`cd a && ${RM} -rf "$PWD"/..`, `PWD=/etc; cd /tmp/x; ${RM} -rf "$PWD"/y`, `export PWD=/; ${RM} -rf "$PWD"/*`];
const SILENT_FROM_ROOT = [
  `${RM} -rf "$PWD"/dist`,
  `cd src && ${RM} -rf "$PWD"/gen`,
  `cd src/a && ${RM} -rf "$PWD"/b/c "$PWD"/d/*`,
  `cd src && ${RM} -rf $(pwd)/gen/*`,
  `cd "$PWD"/src && ${RM} -rf gen`,
  `cd /tmp/cs-test-x && ${RM} -rf "$PWD"/y`,
];

test('after a cd, $PWD and $(pwd) in an rm target mean the folder the cd went to', () => {
  for (const command of ASK_FROM_SRC) assert.ok(asksDestructive(command, inSrc), command);
});

test('after a cd the guard cannot follow, a $PWD target asks: the folder is unknown', () => {
  for (const command of ASK_UNKNOWN_FOLDER) assert.ok(asksDestructive(command, atRoot), command);
});

test('a cd through $PWD after the folder moved makes the folder unknown, so a relative rm asks', () => {
  for (const command of ASK_CD_THROUGH_PWD) assert.ok(asksDestructive(command, inSrc), command);
});

test('the folder the line started in is still judged for a $PWD target: no ask is lost', () => {
  for (const command of ASK_KEPT) assert.ok(asksDestructive(command, inSrc), command);
});

test('a $PWD target inside the project stays silent, before and after a cd into a sub-folder', () => {
  for (const command of SILENT_FROM_ROOT) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
});
