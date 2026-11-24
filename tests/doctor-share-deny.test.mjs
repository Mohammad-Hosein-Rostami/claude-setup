// Tests for the doctor check check_share_deny (scripts/doctor/checks-setup.sh, DOCTOR_ONLY mode): a missing deny list or one with
// comments only is one WARN telling the person to fill it; a list with words is ok and counts them as share-check's parser does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const skip = spawnSync('jq', ['--version']).status !== 0 && 'jq not installed'; // doctor reads the install record with jq
const EMPTY_LIST_WARN = /^WARN\s+add your private names to personal\/share-deny\.txt so share-check can protect them$/m;

/** Runs the check with a temp HOME whose install record names a temp clone; `list` is its personal/share-deny.txt (none when undefined). */
function checkShareDeny(list) {
  const home = makeTempDir('doctor-share-deny-');
  const clone = join(home, 'clone');
  mkdirSync(join(clone, 'personal'), { recursive: true });
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', '.claude-setup-install.json'), JSON.stringify({ repo: clone }));
  if (list !== undefined) writeFileSync(join(clone, 'personal', 'share-deny.txt'), list);
  return spawnSync('bash', [DOCTOR], { env: cleanEnv({ HOME: home, DOCTOR_ONLY: 'check_share_deny' }), encoding: 'utf8' });
}

test('a missing deny list is one WARN that names the file to fill', { skip }, () => {
  const result = checkShareDeny(undefined);
  assert.match(result.stdout, EMPTY_LIST_WARN);
  assert.equal(result.status, 0, 'a WARN does not fail doctor');
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
