// Tests for the doctor check check_share_deny (scripts/doctor/checks-setup.sh, DOCTOR_ONLY mode): no personal/ at all, or a list with
// comments only, is one WARN telling the person to fill it; a missing list beside an existing personal/ (a folder, a link, even a
// dangling one) is a FAIL with the cp fix, because the commit hooks refuse every commit then; a list with words is ok and counts them as
// share-check's parser does.
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
 * `personal` what its personal/ is (PERSONAL). Returns the spawnSync result with `clone`, the clone's path.
 */
function checkShareDeny(list, { personal = PERSONAL.folder } = {}) {
  const home = makeTempDir('doctor-share-deny-');
  const clone = join(home, 'clone');
  mkdirSync(clone);
  if (personal === PERSONAL.folder) mkdirSync(join(clone, 'personal'));
  if (personal === PERSONAL.danglingLink) symlinkSync(join(home, 'gone'), join(clone, 'personal'));
  if (personal === PERSONAL.file) writeFileSync(join(clone, 'personal'), 'not a folder\n');
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', '.claude-setup-install.json'), JSON.stringify({ repo: clone }));
  if (list !== undefined) writeFileSync(join(clone, 'personal', 'share-deny.txt'), list);
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
