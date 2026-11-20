// Tests for `rm -r` forms the shell rewrites before rm sees them, which the guard used to read as written.
// A zsh glob group: `rm -rf (*|.*)` empties the folder, hidden entries too, and zsh (the Bash tool's shell on macOS) expands the group
// without EXTENDED_GLOB. Both parsers cut the line at `(`, `|` and `)`, so the rm had no target at all and was allowed.
// Command strings are only passed to decide(); nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const RM = 'rm'; // kept apart so this file's own text never reads as a command
const atRoot = { cwd: PROJECT, project: PROJECT };
const WHOLE_FOLDER = /^DESTRUCTIVE: rm -r that empties a whole folder \(/;

const firstReason = (command) => decide(command, atRoot).reasons?.[0] ?? 'allowed';

const GROUPS_THAT_EMPTY_THE_FOLDER = [`${RM} -rf (*)`, `${RM} -rf (*|.*)`, `${RM} -rf (a|*)`, `${RM} -rf (.*|a)`, `nice ${RM} -rf (*)`, `${RM} -rf src (*)`];
// `./(*)` asked before as well: its `./` alone is the working directory, which is not "inside the project"
const GROUPS_OUTSIDE = [`${RM} -rf /etc/(a|b)`, `${RM} -rf ../(a|b)`, `${RM} -rf ./(*)`, `${RM} -rf ./(a|.*)`];
const NOT_A_GROUP = [
  `${RM} -rf '(*)'`, // quoted: one word, a file named `(*)`
  `${RM} -rf "(a|*)"`,
  `${RM} -rf dist (a|b)`, // names only
  `${RM} -rf src/(a|b)`,
  `${RM} -rf dist && (cd src && make)`, // a subshell after `&&` is not a group of the rm
  `${RM} -rf dist; (make)`,
  `${RM} -f (*)`, // not recursive: not judged here
];

test('each branch of a glob group after a recursive rm is judged as a target: a bare glob among them empties the folder', () => {
  for (const command of GROUPS_THAT_EMPTY_THE_FOLDER) assert.match(firstReason(command), WHOLE_FOLDER, command);
});

test('a group glued to a path outside the project asks as outside', () => {
  for (const command of GROUPS_OUTSIDE) assert.match(firstReason(command), /^DESTRUCTIVE: rm -r outside the project \(/, command);
});

test('a quoted group is a name, a group of names is judged by its names, and a subshell after the rm is no group', () => {
  for (const command of NOT_A_GROUP) assert.deepEqual(decide(command, atRoot), { allow: true }, command);
});
