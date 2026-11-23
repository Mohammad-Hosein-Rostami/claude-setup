// Tests for the scratch areas of `rm -r` (home/hooks/lib/rm-paths.mjs deletedPath, inScratchArea; owner FR6, 2026-11-22: no popup for
// deletes inside the session's own temp area and `cs-test-*` folders, elsewhere it still asks). The guard reads where an rm really
// deletes: links are followed as the kernel follows them, so a link inside the scratchpad cannot carry an rm out of it unasked, and
// the folders of Claude Code's temp tree down to a session folder (`$S/..`) ask. A fake temp root (TMPDIR, a `cs-test-` folder) holds
// a fake session tree `claude-501/<project>/<session>/scratchpad`; the links are made there and removed at the end. Command strings
// are only passed to decide(); nothing they name is executed.
import { PINNED_HOME } from './pin-home.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeTempDir } from './temp-dir-helpers.mjs';

const TEMP = makeTempDir('scratch-rm-'); // `<tmpdir>/cs-test-scratch-rm-XXXXXX`: TEMP itself is a cs-test folder
process.env.TMPDIR = TEMP; // the guard reads its temp root when it loads, so it loads after this
const SESSION_ID = '8e63904d-6ae5-474c-9b08-920c34e5c97d';
process.env.CLAUDE_CODE_SESSION_ID = SESSION_ID; // the session the guard runs in (Claude Code sets it for its hooks)
const { decide } = await import('../home/hooks/pre-bash-guard.mjs');
after(() => removeTempDir(TEMP));

const REAL_TEMP = realpathSync(TEMP); // on macOS `/var/folders/...` is `/private/var/folders/...`
const SESSION = join(TEMP, 'claude-501', '-Users-owner-proj', SESSION_ID);
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

const asksDestructive = (command) => assert.ok(decide(command, ctx).reasons?.some((reason) => reason.startsWith('DESTRUCTIVE: ')), command);
const LINKS = join(TEMP, 'cs-test-c'); // holds the link l, which leads out of every scratch area
const A = join(TEMP, 'cs-test-a');
mkdirSync(LINKS);
symlinkSync(OUTSIDE, join(LINKS, 'l'));

test('R1: no scratch exemption on a line with a command that may make the link the delete goes through', () => {
  const m = `${A}/m`;
  [`mv ${LINKS}/l ${m} && ${RM} -rf ${m}/old`, `cp -a ${LINKS}/l ${m} && ${RM} -rf ${m}/old`, `cp -P ${LINKS}/l ${m}; ${RM} -rf ${m}/old`,
    `tar -xf x.tar -C ${A} && ${RM} -rf ${m}/old`, `unzip x.zip -d ${A} && ${RM} -rf ${m}/old`, `rsync -a ${LINKS}/ ${A}/ && ${RM} -rf ${A}/l/old`,
    `git clone u ${m} && ${RM} -rf ${m}/old`, `node make-links.mjs; ${RM} -rf ${m}/old`, `cd ${A} && mv ../cs-test-c/l m && ${RM} -rf m/old`,
    `D=$(mktemp -d); mv ${LINKS}/l $D/m && ${RM} -rf $D/m/old`, `S=${S}; mv ${LINKS}/l "$S/m"; ${RM} -rf "$S/m/x"`,
  ].forEach(asksDelete);
  // the link maker written after the delete: a loop, a pipe or `&` may run it first
  [`for i in 1 2; do ${RM} -rf ${m}/old; mv ${LINKS}/l ${m}; done`, `${RM} -rf ${m}/old & mv ${LINKS}/l ${m}`,
    `${RM} -rf ${m}/old | ln -s ~ ${m}`, `${RM} -rf ${m}/old; bash -c 'mv ${LINKS}/l ${m}'`].forEach(asksDestructive);
  [`mkdir -p ${m} && ${RM} -rf ${m}/old`, `cd "${S}" && ${RM} -rf fx4`, `D=$(mktemp -d); cp -a x $D/m; ${RM} -rf $D/m`,
    `rsync -a --delete src/ ${A}/dst/`, `D=$(mktemp -d); git clone u $D/r; ${RM} -rf $D/r`, `for d in a b; do echo "$d"; done; ${RM} -rf ${A}/x`].forEach(quiet);
});

test('R2: find -L/-follow and rsync -K/-k with --delete follow links below their target, so they ask; -H follows the start folder', () => {
  [`find -L ${S} -delete`, `find ${S} -follow -delete`, `find -L ${S}/plain -name x -delete`, `find -L ${S} -exec ${RM} -rf {} +`,
    `find -H ${S}/linked/repo -delete`, `rsync -aK --delete src/ ${S}/d/`, `rsync -a --keep-dirlinks --delete src/ ${S}/d/`,
    `rsync -ak --delete src/ ${S}/d/`, `rsync -a --copy-dirlinks --delete src/ ${S}/d/`, `rsync -a --delete src/ ${S}/linked/repo`].forEach(asksDestructive);
  [`find ${S}/plain -delete`, `find ${S}/linked/repo -delete`, `find -P ${S}/plain -name x -delete`, `rsync -a --delete src/ ${S}/d/`].forEach(quiet);
});

test('R3: a cs-test folder that holds home asks also when HOME is written through a link', (t) => {
  const home = process.env.HOME;
  t.after(() => { process.env.HOME = home; });
  mkdirSync(join(TEMP, 'cs-test-h', 'home', 'cs-test-a'), { recursive: true });
  symlinkSync(join(TEMP, 'cs-test-h'), join(TEMP, 'cs-test-hlink'));
  process.env.HOME = join(TEMP, 'cs-test-hlink', 'home'); // its real path lies under cs-test-h
  [`${RM} -rf ~`, `${RM} -rf ~/x`, `${RM} -rf ${REAL_TEMP}/cs-test-h`, `${RM} -rf ${REAL_TEMP}/cs-test-h/home`].forEach(asksDelete);
  quiet(`${RM} -rf ~/cs-test-a/x`);
});

test('R4: the hook input\'s session_id names the free session folder, before the environment\'s id', (t) => {
  t.after(() => { process.env.CLAUDE_CODE_SESSION_ID = SESSION_ID; });
  delete process.env.CLAUDE_CODE_SESSION_ID;
  const other = join(TEMP, 'claude-501', '-Users-owner-proj', '11111111-2222-3333-4444-555555555555', 'scratchpad');
  const withInput = { ...ctx, sessionId: SESSION_ID };
  assert.deepEqual(decide(`${RM} -rf ${S}/x`, withInput), { allow: true });
  assert.ok(decide(`${RM} -rf ${other}/x`, withInput).ask);
  process.env.CLAUDE_CODE_SESSION_ID = '11111111-2222-3333-4444-555555555555'; // the input wins over the environment
  assert.deepEqual(decide(`${RM} -rf ${S}/x`, withInput), { allow: true });
  assert.ok(decide(`${RM} -rf ${other}/x`, withInput).ask);
});

test('R4: only this session\'s own folder is free: another session, any other temp folder and no session id ask', (t) => {
  const other = join(TEMP, 'claude-501', '-Users-owner-proj', '11111111-2222-3333-4444-555555555555', 'scratchpad');
  [`${RM} -rf ${other}`, `${RM} -rf ${other}/x`, `${RM} -rf /private/tmp/claude-501/-Users-x-proj/11111111-2222-3333-4444-555555555555/scratchpad`,
    `${RM} -rf /tmp/foo`, `${RM} -rf /private/tmp/build/*`, `${RM} -rf /tmp/x/y`, // TEMP itself is a cs-test folder: free, as FR6 says
    `${RM} -rf ${TEMP}/claude-501/*/${SESSION_ID}/scratchpad/x`, `${RM} -rf ${TEMP}/claude-501/-Users-owner-proj/${SESSION_ID.slice(0, 8)}*/x`].forEach(asksDelete);
  quiet(`${RM} -rf ${S}/x`);
  t.after(() => { process.env.CLAUDE_CODE_SESSION_ID = SESSION_ID; });
  for (const id of [undefined, '..', 'a/b', '']) {
    if (id === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = id;
    asksDelete(`${RM} -rf ${S}/x`);
  }
});

const RUNNER = fileURLToPath(new URL('./win32-decide.mjs', import.meta.url));
const skip = typeof nodeModule.registerHooks === 'function' ? false : 'node:module registerHooks is missing in this Node (added in 22.15)';

test('Windows paths: a drive or Git Bash path is never read as a session area; a cs-test folder on a drive is one', { skip }, () => {
  const project = 'C:\\Users\\devuser\\proj';
  const temp = '/c/Users/devuser/AppData/Local/Temp';
  const answers = { ask: [`${RM} -rf /c/Users/devuser/x`, `${RM} -rf ${temp}/claude-501/p/8e63904d`, `${RM} -rf /c/tmp/claude-501/p/8e63904d`,
    `${RM} -rf /c/cs-test-a/../x`], allow: [`${RM} -rf C:/Users/devuser/cs-test-a/x`, `cd /c/Users/devuser/cs-test-a && ${RM} -rf x`, `${RM} -rf $TMPDIR/cs-test-x`] };
  const commands = [...answers.ask, ...answers.allow];
  const { status, stdout, stderr } = spawnSync(process.execPath, [RUNNER, JSON.stringify({ cwd: project, project, commands })], { encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  const got = JSON.parse(stdout);
  for (const [answer, list] of Object.entries(answers)) for (const command of list) assert.equal(got[command], answer, command);
});
