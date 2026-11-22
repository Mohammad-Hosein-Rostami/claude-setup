// Tests for the scratch areas of `rm -r` (home/hooks/lib/rm-paths.mjs deletedPath, inScratchArea; owner FR6, 2026-11-22: no popup for
// deletes inside the session's own temp area and `cs-test-*` folders, elsewhere it still asks). The guard reads where an rm really
// deletes: links are followed as the kernel follows them, so a link inside the scratchpad cannot carry an rm out of it unasked, and
// the folders of Claude Code's temp tree down to a session folder (`$S/..`) ask. A fake temp root (TMPDIR, a `cs-test-` folder) holds
// a fake session tree `claude-501/<project>/<session>/scratchpad`; the links are made there and removed at the end. Command strings
// are only passed to decide(); nothing they name is executed.
import { PINNED_HOME } from './pin-home.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEMP = mkdtempSync(join(tmpdir(), 'cs-test-scratch-rm-'));
process.env.TMPDIR = TEMP; // the guard reads its temp root when it loads, so it loads after this
const { decide } = await import('../home/hooks/pre-bash-guard.mjs');
after(() => rmSync(TEMP, { recursive: true, force: true }));

const REAL_TEMP = realpathSync(TEMP); // on macOS `/var/folders/...` is `/private/var/folders/...`
const SESSION = join(TEMP, 'claude-501', '-Users-owner-proj', '8e63904d-6ae5-474c-9b08-920c34e5c97d');
const S = join(SESSION, 'scratchpad');
const OUTSIDE = fileURLToPath(new URL('.', import.meta.url)); // an existing folder outside every temp root (this repo's tests)
mkdirSync(join(S, 'linked'), { recursive: true });
mkdirSync(join(S, 'plain', 'a'), { recursive: true });
symlinkSync(PINNED_HOME, join(S, 'linked', 'home')); // home does not exist here: a link that leads nowhere yet
symlinkSync(OUTSIDE, join(S, 'linked', 'repo'));

const PROJECT = resolve('/work/proj');
const RM = 'rm'; // kept apart so this file's own text never reads as a command
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: [] };
const quiet = (command) => assert.deepEqual(decide(command, ctx), { allow: true }, command);
const asksDelete = (command) => assert.ok(decide(command, ctx).reasons?.some((reason) => reason.startsWith('DESTRUCTIVE: rm -r')), command);

test('the checkpoint cases: a delete in the scratchpad or a cs-test folder runs, ~, $S/.., cd /tmp && rm * and a link out ask', () => {
  [`S=${S}; cd "$S" && ${RM} -rf fx4`, `${RM} -rf $TMPDIR/cs-test-x`].forEach(quiet);
  [`${RM} -rf ~/x`, `S=${S}; ${RM} -rf "$S/.."`, `cd /tmp && ${RM} -rf *`, `${RM} -rf ${S}/linked/home/x`].forEach(asksDelete);
});

test('the session area and cs-test folders, by real path: written through /var or /private/var, after a cd, a glob of plain folders', () => {
  [`cd "${S}" && ${RM} -rf fx4 t1`, `${RM} -rf ${S}/fx4`, `${RM} -rf "${S}"`, `${RM} -rf ${REAL_TEMP}/cs-test-x`, `${RM} -rf ${TEMP}/cs-test-x/`,
    `${RM} -rf ${S}/plain/*/x`, `${RM} -rf ${S}/fx*`, `${RM} -rf ${SESSION}/../${SESSION.split('/').pop()}/scratchpad/x`,
    `${RM} -rf /tmp/cs-test-a/b`, `${RM} -rf /tmp/cs-test-*`, `${RM} -rf ~/cs-test-probe`, `${RM} -rf /work/elsewhere/cs-test-a/x`,
    `cd /work/elsewhere/cs-test-a && ${RM} -rf x`, `${RM} -rf ${S}/linked/repo`, `${RM} -rf ${S}/linked/home`].forEach(quiet);
});

test('Claude Code\'s temp tree down to a session folder asks: the session, its project, claude-<uid>, a glob over sessions', () => {
  [`${RM} -rf "${S}/.."`, `${RM} -rf ${S}/../..`, `${RM} -rf ${SESSION}`, `${RM} -rf ${REAL_TEMP}/claude-501/-Users-owner-proj`,
    `${RM} -rf ${TEMP}/claude-501`, `${RM} -rf ${TEMP}/claude-501/*/*/scratchpad`, `${RM} -rf ${TEMP}/c*`, `${RM} -rf /tmp/claude-1000`,
    `${RM} -rf /private/tmp/claude-501/-Users-owner/8e63904d-6ae5-474c-9b08-920c34e5c97d`, `cd "${S}" && ${RM} -rf ..`,
    `cd ${TEMP} && ${RM} -rf *`, `${RM} -rf ${REAL_TEMP}/*`].forEach(asksDelete);
});

test('a link, a glob over links, a variable or a missing value inside the scratch path never carries an rm out unasked', () => {
  [`${RM} -rf ${S}/linked/repo/x`, `${RM} -rf ${S}/linked/repo/`, `${RM} -rf ${S}/linked/repo/.`, `${RM} -rf ${S}/linked/home/`,
    `${RM} -rf ${S}/linked/repo/../x`, `cd ${S}/linked/repo && ${RM} -rf x`, `cd ${S}/linked && ${RM} -rf repo/x`, `${RM} -rf ${S}/linked/*/x`,
    `${RM} -rf ${S}/plain/*/b/c`, `${RM} -rf ${S}/$X`, `X=../../../../..; ${RM} -rf ${S}/$X`, `${RM} -rf "$S/"`, `S=; ${RM} -rf "$S/"`,
    `cd /missing-folder && ${RM} -rf x`, `${RM} -rf '/tmp/a\\b/../../etc'`, // off Windows a `\` is part of a name: that is /etc
 `${RM} -rf ~/cs-test-a/../x`, `${RM} -rf /work/cs-test-a/../proj-x`].forEach(asksDelete);
});

test('a cs-test folder that is home or holds it is no scratch area', (t) => {
  const home = process.env.HOME;
  t.after(() => { process.env.HOME = home; });
  process.env.HOME = resolve('/work/cs-test-home/owner');
  [`${RM} -rf ~/x`, `${RM} -rf /work/cs-test-home`, `${RM} -rf ~`].forEach(asksDelete);
  quiet(`${RM} -rf /work/cs-test-other/x`);
});

const RUNNER = fileURLToPath(new URL('./win32-decide.mjs', import.meta.url));
const skip = typeof nodeModule.registerHooks === 'function' ? false : 'node:module registerHooks is missing in this Node (added in 22.15)';

test('Windows paths: a drive or Git Bash path is never read as a session area; a cs-test folder on a drive is one', { skip }, () => {
  const project = 'C:\\Users\\pejvak\\proj';
  const temp = '/c/Users/pejvak/AppData/Local/Temp';
  const answers = { ask: [`${RM} -rf /c/Users/pejvak/x`, `${RM} -rf ${temp}/claude-501/p/8e63904d`, `${RM} -rf /c/tmp/claude-501/p/8e63904d`,
    `${RM} -rf /c/cs-test-a/../x`], allow: [`${RM} -rf C:/Users/pejvak/cs-test-a/x`, `cd /c/Users/pejvak/cs-test-a && ${RM} -rf x`, `${RM} -rf $TMPDIR/cs-test-x`] };
  const commands = [...answers.ask, ...answers.allow];
  const { status, stdout, stderr } = spawnSync(process.execPath, [RUNNER, JSON.stringify({ cwd: project, project, commands })], { encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  const got = JSON.parse(stdout);
  for (const [answer, list] of Object.entries(answers)) for (const command of list) assert.equal(got[command], answer, command);
});
