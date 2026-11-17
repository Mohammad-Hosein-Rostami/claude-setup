// Tests for the doctor check check_repo_tests (scripts/doctor.sh, DOCTOR_ONLY mode): the suite output is kept in a log file,
// and a failure names the failing tests with their first error line. DOCTOR_TEST_COMMAND replaces the real suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));

async function runCheck(suiteCommand) {
  const home = await mkdtemp(join(tmpdir(), 'doctor-suite-'));
  const logDir = join(home, 'log-dir');
  const env = { ...process.env, HOME: home, DOCTOR_ONLY: 'check_repo_tests', DOCTOR_TEST_COMMAND: suiteCommand, DOCTOR_LOG_DIR: logDir };
  const result = spawnSync('bash', [DOCTOR], { env, encoding: 'utf8' });
  return { result, logFile: join(logDir, 'doctor-repo-tests.log') };
}

const FAKE_TAP = [
  'echo "TAP version 13"',
  'echo "ok 1 - fine test"',
  'echo "not ok 2 - broken assertion"',
  'echo "  error: |-"',
  'echo "    Expected values to be strictly equal:"',
  'echo "not ok 3 - broken throw"',
  'echo "  error: \'boom here\'"',
  'exit 1',
].join('; ');

test('a passing suite prints ok and keeps its output in the log file', async () => {
  const { result, logFile } = await runCheck('echo "ok 1 - fine test"');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^ok\s+repo tests pass/m);
  assert.match(await readFile(logFile, 'utf8'), /ok 1 - fine test/);
});

test('a failing suite names each failing test with its first error line and prints the log path', async () => {
  const { result, logFile } = await runCheck(FAKE_TAP);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL\s+repo tests fail/m);
  assert.match(result.stdout, /not ok 2 - broken assertion/);
  assert.match(result.stdout, /Expected values to be strictly equal:/);
  assert.match(result.stdout, /not ok 3 - broken throw/);
  assert.match(result.stdout, /boom here/);
  assert.doesNotMatch(result.stdout, /fine test/);
  assert.ok(result.stdout.includes(logFile), 'the log path is printed');
  assert.match(await readFile(logFile, 'utf8'), /not ok 2 - broken assertion/);
});

test('a failing suite with no test lines (crash) still prints the last log lines', async () => {
  const { result } = await runCheck('echo "Error: cannot find module x" >&2; exit 1');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /cannot find module x/);
});

test('when the log folder cannot be made, the fallback log is a fresh file, not a fixed name another user could plant', async () => {
  const home = await mkdtemp(join(tmpdir(), 'doctor-suite-'));
  const sharedTmp = join(home, 'shared-tmp');
  const blocker = join(home, 'blocker');
  await writeFile(blocker, 'a file, so a folder cannot be made below it');
  spawnSync('mkdir', [sharedTmp]);
  const plantedLog = join(sharedTmp, 'doctor-repo-tests.log');
  await writeFile(plantedLog, 'PLANTED-BY-ANOTHER-USER', { mode: 0o444 });
  const env = {
    ...process.env, HOME: home, TMPDIR: sharedTmp, DOCTOR_ONLY: 'check_repo_tests',
    DOCTOR_TEST_COMMAND: 'echo "not ok 1 - real failure"; exit 1', DOCTOR_LOG_DIR: join(blocker, 'logs'),
  };
  const result = spawnSync('bash', [DOCTOR], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not ok 1 - real failure/);
  assert.doesNotMatch(result.stdout, /PLANTED-BY-ANOTHER-USER/);
  assert.ok(!result.stdout.includes(plantedLog), 'the fixed, plantable path is not used');
});
