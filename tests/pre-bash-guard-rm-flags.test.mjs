// Tests that an abbreviated GNU long option makes an rm recursive for the guard. GNU getopt takes any unambiguous prefix of a long option
// (coreutils manual, "Common options"), and Git Bash on the PC and Linux ship GNU rm: `rm --rec -f ~` there is `rm --recursive -f ~`.
// `--recursive` is rm's only long option that starts with r and `--no-preserve-root` its only one that starts with n, so every prefix of
// either counts (the second is only ever written for a recursive delete). Command strings are only passed to decide(); nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { RECURSIVE_FLAG } from '../home/hooks/lib/rm-paths.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const RM = 'rm'; // kept apart so this file's own text never reads as a command
const ctx = { cwd: PROJECT, project: PROJECT };

/** @returns {boolean} true when the guard asks with a DESTRUCTIVE reason */
const asksDestructive = (command) => decide(command, ctx).reasons?.some((reason) => reason.startsWith('DESTRUCTIVE:')) === true;

const RECURSIVE = ['-r', '-R', '-rf', '-fR', '--recursive', '--recursiv', '--recurs', '--recu', '--rec', '--re', '--r', '--no-preserve-root', '--no-preserve', '--no-pre', '--no', '--n'];
const NOT_RECURSIVE = ['-f', '-v', '-i', '--force', '--verbose', '--interactive', '--one-file-system', '--preserve-root', '--dir', '--', '--recursively', '--rx', '--nope', '-', 'r', '--help'];

const ASK = [
  `${RM} --rec -f ~`,
  `${RM} --recu -f /work/other`,
  `${RM} --rec -f ..`,
  `${RM} --r -f *`,
  `${RM} --recu *`,
  `${RM} --recursiv --force ./*`,
  `${RM} --re /etc/x`,
  `${RM} --no-preserve-root /etc/x`,
  `${RM} --no-pre -f /`,
  `sudo ${RM} --rec /etc/x`,
  `find /etc -name x -exec ${RM} --rec {} +`,
  `cat list.txt | xargs ${RM} --rec -f`,
  `python3 -c "import os; os.system('${RM} --rec /etc/x')"`,
];
const SILENT = [`${RM} --rec build`, `${RM} --force x.log`, `${RM} --verbose -f *`, `${RM} --interactive=never notes.txt`, `${RM} --rec src/*`];

test('RECURSIVE_FLAG takes -r, -R, a cluster holding one, and every prefix of --recursive and --no-preserve-root', () => {
  for (const flag of RECURSIVE) assert.equal(RECURSIVE_FLAG.test(flag), true, flag);
  for (const flag of NOT_RECURSIVE) assert.equal(RECURSIVE_FLAG.test(flag), false, flag);
});

test('an rm with an abbreviated recursive option is judged like rm -r: outside the project and whole folders ask', () => {
  for (const command of ASK) assert.ok(asksDestructive(command), command);
});

test('an abbreviated recursive rm inside the project, and long options that are not recursive, stay silent', () => {
  for (const command of SILENT) assert.deepEqual(decide(command, ctx), { allow: true }, command);
});
