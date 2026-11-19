// Tests for the guard's path rules under Windows path semantics (the PC is the owner's primary machine; Bash tool commands there are
// Git Bash syntax, `/c/Users/x`). A bare Git Bash drive, `/c`, is the drive root: `cd /c && rm -rf Users` deletes C:\Users, and the
// guard used to read `/c` as `c:` ("the current folder on drive c"), so that cd looked like no move at all.
// Simulated: tests/win32-decide.mjs gives the guard path.win32 and platform 'win32' in a child process. NOT run on Windows; the real
// Git Bash is not involved. Command strings are only passed to decide(); nothing is executed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as nodeModule from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./win32-decide.mjs', import.meta.url));
const PROJECT = 'C:\\Users\\pejvak\\proj';
const RM = 'rm'; // kept apart so this file's own text never reads as a command
const skip = typeof nodeModule.registerHooks === 'function' ? false : 'node:module registerHooks is missing in this Node (added in 22.15)';

/** The guard's answers ('ask' | 'allow') for the commands, judged with Windows paths from the project root. */
function win32Answers(commands) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [RUNNER, JSON.stringify({ cwd: PROJECT, project: PROJECT, commands })], { encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  return JSON.parse(stdout);
}

const ASK = [
  `cd /c && ${RM} -rf Users`,
  `cd /c && ${RM} -rf Users/pejvak`,
  `cd /C && ${RM} -rf Users/pejvak/Documents`,
  `cd /c && ${RM} -rf Users/pejvak/proj`,
  `cd /c/ && ${RM} -rf Users`,
  `cd /c && ${RM} -rf *`,
  `cd /d && ${RM} -rf x`,
  `pushd /c && ${RM} -rf Windows`,
  `${RM} -rf /c`,
  `${RM} -rf /c/*`,
  `${RM} -rf /c/Users/*`,
  `${RM} -rf C:/*`,
  `${RM} -rf /c/Users/pejvak/proj/*`,
  `${RM} -rf *`,
  `cd .. && ${RM} -rf proj`,
];
const SILENT = [
  `${RM} -rf src/*`,
  `${RM} -rf /c/Users/pejvak/proj/src/gen`,
  `cd /c/Users/pejvak/proj/src && ${RM} -rf gen`,
  `cd /c && ${RM} -rf Users/pejvak/proj/src/gen`,
  `cd /c && ${RM} -rf /c/Users/pejvak/proj/dist`,
];

test('a bare Git Bash drive is the drive root: a cd to it moves, and what rm then names is judged from there', { skip }, () => {
  const answers = win32Answers(ASK);
  for (const command of ASK) assert.equal(answers[command], 'ask', command);
});

test('targets inside the project stay silent under Windows paths, also after a cd to the drive root', { skip }, () => {
  const answers = win32Answers(SILENT);
  for (const command of SILENT) assert.equal(answers[command], 'allow', command);
});
