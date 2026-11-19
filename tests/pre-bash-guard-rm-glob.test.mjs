// Tests for a recursive rm that empties a whole folder from inside the project: a bare glob (`*`, `./*`, `.*`, `?`) of the working
// directory or the project root, or the working directory itself, asks like `rm -rf /` does (DESTRUCTIVE), wherever the shell stands.
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
const ASK_IN_SUBFOLDER = [`${RM} -rf *`, `${RM} -rf .*`, `${RM} -rf .`, `${RM} -rf ./`, `${RM} -rf "$PWD"`, `${RM} -rf ../*`];
const ALREADY_ASKED = [`${RM} -rf /`, `${RM} -rf /*`, `${RM} -rf ~`, `${RM} -rf ~/*`, `${RM} -rf .`, `cd ~ && ${RM} -rf *`];
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
];

test('a recursive rm of a bare glob in the working directory or the project root asks as destructive', () => {
  for (const command of ASK_AT_ROOT) assert.ok(asksDestructive(command, atRoot), command);
});

test('from a sub-folder, a bare glob, the working directory itself and the glob of the project root ask', () => {
  for (const command of ASK_IN_SUBFOLDER) assert.ok(asksDestructive(command, inSrc), command);
});

test('root, home and the project root keep asking as before', () => {
  for (const command of ALREADY_ASKED) assert.ok(asksDestructive(command, atRoot), command);
});

test('a glob of a sub-folder, a glob with a name part, named targets and a non-recursive rm stay silent', () => {
  for (const command of SILENT) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
});
