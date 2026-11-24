// Tests for the doctor check check_share_deny (scripts/doctor/checks-setup.sh, DOCTOR_ONLY mode): no personal/ at all, or a list with
// comments only, is one WARN telling the person to fill it; a missing list beside an existing personal/ (a folder, a link, even a
// dangling one) is a FAIL with the cp fix, because the commit hooks refuse every commit then; a list with words is ok and counts them as
// share-check's parser does. The list is read as share-check reads it: a link (to a file or dangling) or a list over the cap is the
// not-readable FAIL; a list of exactly the cap is still read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const skip = spawnSync('jq', ['--version']).status !== 0 && 'jq not installed'; // doctor reads the install record with jq
const EMPTY_LIST_WARN = /^WARN\s+add your private names to personal\/share-deny\.txt so share-check can protect them$/m;
// What the clone's personal/ is: a folder (the default), nothing, a link to a path that does not exist, or a plain file.
const PERSONAL = { folder: 'folder', none: 'none', danglingLink: 'dangling link', file: 'file' };
const noSymlinks = process.platform === 'win32' && 'symlinks need extra rights on Windows';
const NOT_READABLE_FAIL = /^FAIL\s+share-check deny list .*share-deny\.txt is not readable$/m;
const DENY_LIST_OK = /^ok\s+share-check deny list:/m;
const ANY_WARN = /^WARN/m;
// share-check's cap on the list (DENY_MAX_BYTES in scripts/share-check/match.mjs), spelled out so the test pins the number itself.
const DENY_MAX_BYTES = 1024 * 1024;
// Words a followed link would count, so a doctor that follows the link says ok instead of the FAIL.
const LINKED_LIST = 'Quokka Ltd\nZebracorp\n';
// What personal/share-deny.txt is when it is a link: one to a real list with words, or one to a path that does not exist.
const LIST_LINK = { toFile: 'link to a file', dangling: 'dangling link' };

/**
 * The FAIL line doctor prints for a list missing beside personal/ in `clone`, as a whole-line regexp. The paths are joined with `/`, as
 * doctor (bash) joins them onto the install record's repo, on Windows too.
 */
const missingBesidePersonal = (clone) => {
  const list = `${clone}/personal/share-deny.txt`;
  const line = `FAIL  share-check deny list ${list} is missing beside ${clone}/personal, so every commit there fails; run: cp '${clone}/personal.example/share-deny.txt' '${list}'`;
  return new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
};

/**
 * Runs the check with a temp HOME whose install record names a temp clone; `list` is its personal/share-deny.txt (none when undefined),
 * `personal` what its personal/ is (PERSONAL), `listLink` the list as a link instead (LIST_LINK). Returns the spawnSync result with `clone`, the clone's path.
 */
function checkShareDeny(list, { personal = PERSONAL.folder, listLink } = {}) {
  const home = makeTempDir('doctor-share-deny-');
  const clone = join(home, 'clone');
  mkdirSync(clone);
  if (personal === PERSONAL.folder) mkdirSync(join(clone, 'personal'));
  if (personal === PERSONAL.danglingLink) symlinkSync(join(home, 'gone'), join(clone, 'personal'));
  if (personal === PERSONAL.file) writeFileSync(join(clone, 'personal'), 'not a folder\n');
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', '.claude-setup-install.json'), JSON.stringify({ repo: clone }));
  if (list !== undefined) writeFileSync(join(clone, 'personal', 'share-deny.txt'), list);
  if (listLink === LIST_LINK.toFile) {
    writeFileSync(join(home, 'real-share-deny.txt'), LINKED_LIST);
    symlinkSync(join(home, 'real-share-deny.txt'), join(clone, 'personal', 'share-deny.txt'));
  }
  if (listLink === LIST_LINK.dangling) symlinkSync(join(home, 'gone-share-deny.txt'), join(clone, 'personal', 'share-deny.txt'));
  const result = spawnSync('bash', [DOCTOR], { env: cleanEnv({ HOME: home, DOCTOR_ONLY: 'check_share_deny' }), encoding: 'utf8' });
  return { ...result, clone };
}

test('no personal/ at all is one WARN that names the file to fill', { skip }, () => {
  const result = checkShareDeny(undefined, { personal: PERSONAL.none });
  assert.match(result.stdout, EMPTY_LIST_WARN);
  assert.equal(result.status, 0, 'a WARN does not fail doctor');
});

test('a missing deny list beside an existing personal/ folder is a FAIL that names the cp from personal.example', { skip }, () => {
  const result = checkShareDeny(undefined);
  assert.match(result.stdout, missingBesidePersonal(result.clone));
  assert.doesNotMatch(result.stdout, EMPTY_LIST_WARN);
  assert.equal(result.status, 1, 'a FAIL fails doctor');
});

test('personal/ as a dangling link is the same FAIL: anything at personal/ makes share-check refuse every commit', { skip: skip || noSymlinks }, () => {
  const result = checkShareDeny(undefined, { personal: PERSONAL.danglingLink });
  assert.match(result.stdout, missingBesidePersonal(result.clone));
  assert.equal(result.status, 1);
});

test('personal as a plain file is a FAIL for the list, never the WARN', { skip }, () => {
  const result = checkShareDeny(undefined, { personal: PERSONAL.file });
  const list = `${result.clone}/personal/share-deny.txt`;
  assert.ok(result.stdout.split('\n').some((row) => row.startsWith(`FAIL  share-check deny list ${list} `)), result.stdout);
  assert.doesNotMatch(result.stdout, EMPTY_LIST_WARN);
  assert.equal(result.status, 1);
});

test('the shipped template (comments and blank lines only) is the same WARN', { skip }, () => {
  const template = readFileSync(fileURLToPath(new URL('../personal.example/share-deny.txt', import.meta.url)), 'utf8');
  const result = checkShareDeny(template);
  assert.match(result.stdout, EMPTY_LIST_WARN);
});

test('a list that cannot be read is a FAIL, never read as empty', { skip }, () => {
  const home = makeTempDir('doctor-share-deny-');
  mkdirSync(join(home, 'clone', 'personal', 'share-deny.txt'), { recursive: true });
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', '.claude-setup-install.json'), JSON.stringify({ repo: join(home, 'clone') }));
  const result = spawnSync('bash', [DOCTOR], { env: cleanEnv({ HOME: home, DOCTOR_ONLY: 'check_share_deny' }), encoding: 'utf8' });
  assert.match(result.stdout, /^FAIL\s+share-check deny list .*share-deny\.txt is not readable$/m);
  assert.equal(result.status, 1);
});

test('a list with words is ok and counts each word once, as share-check does', { skip }, () => {
  const result = checkShareDeny('# my words\nQuokka Ltd\n\n  quokka ltd  \nZebracorp\r\n');
  assert.match(result.stdout, /^ok\s+share-check deny list: 2 words$/m);
  assert.doesNotMatch(result.stdout, /WARN/);
});

/** Asserts the not-readable FAIL and that doctor neither counted the list (ok) nor called it empty (WARN). */
function assertNotReadableFail(result) {
  assert.match(result.stdout, NOT_READABLE_FAIL);
  assert.doesNotMatch(result.stdout, DENY_LIST_OK);
  assert.doesNotMatch(result.stdout, ANY_WARN);
  assert.equal(result.status, 1, 'a FAIL fails doctor');
}

test('a list that is a link to a file with words is the not-readable FAIL, as share-check refuses a link', { skip: skip || noSymlinks }, () => {
  assertNotReadableFail(checkShareDeny(undefined, { listLink: LIST_LINK.toFile }));
});

test('a list that is a dangling link is the not-readable FAIL, never the empty-list WARN', { skip: skip || noSymlinks }, () => {
  assertNotReadableFail(checkShareDeny(undefined, { listLink: LIST_LINK.dangling }));
});

test('a list one byte over the cap is the not-readable FAIL, even when it holds a word', { skip }, () => {
  assertNotReadableFail(checkShareDeny('a'.repeat(DENY_MAX_BYTES + 1)));
});

test('a list of exactly the cap is read and its word counted', { skip }, () => {
  const result = checkShareDeny(`${'a'.repeat(DENY_MAX_BYTES - 1)}\n`);
  assert.match(result.stdout, /^ok\s+share-check deny list: 1 words$/m);
  assert.doesNotMatch(result.stdout, ANY_WARN);
  assert.equal(result.status, 0);
});
