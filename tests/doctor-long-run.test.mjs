// Tests for the doctor check check_long_run (scripts/doctor/checks-machine.sh, DOCTOR_ONLY mode, spec 21): a missing dependency
// folder and a failing `long-run.mjs check --deps` each give one FAIL line with the fix, and a passing one gives the ok line.
// The doctor scripts are copied into a fake checkout in a temp folder (doctor.sh finds its repo from its own path), whose
// long-run.mjs is a stand-in that prints what the real CLI prints; HOME is a temp folder too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url));
const DEPS = ['@langchain/langgraph', '@langchain/langgraph-checkpoint-sqlite', 'better-sqlite3'];
const FIX = 'run scripts/install.sh; Windows: scripts/install.ps1';
const ABI_REFUSAL = `long-run: deps: the SQLite module does not load (built for another Node ABI, this Node 26.5.0 needs 147) (${FIX})`;

/** A fake checkout: the doctor scripts, a long-run folder with the given dependency folders and a stand-in CLI. */
function checkout({ deps = DEPS, cli = '' } = {}) {
  const repo = makeTempDir('doctor-long-run-');
  mkdirSync(join(repo, 'scripts'));
  cpSync(join(SCRIPTS, 'doctor.sh'), join(repo, 'scripts', 'doctor.sh'));
  cpSync(join(SCRIPTS, 'doctor'), join(repo, 'scripts', 'doctor'), { recursive: true });
  const tool = join(repo, 'home', 'tools', 'long-run');
  for (const dep of deps) mkdirSync(join(tool, 'node_modules', dep), { recursive: true });
  mkdirSync(tool, { recursive: true });
  writeFileSync(join(tool, 'long-run.mjs'), cli);
  return repo;
}

function doctor(repo) {
  const home = makeTempDir('doctor-long-run-home-');
  return spawnSync('bash', [join(repo, 'scripts', 'doctor.sh')], { env: { ...process.env, HOME: home, DOCTOR_ONLY: 'check_long_run' }, encoding: 'utf8' });
}

test('a missing dependency folder: FAIL "long-run deps (<fix>)" naming it, exit 1, and check --deps is not run', () => {
  const repo = checkout({ deps: DEPS.slice(0, 2), cli: "require('node:fs').writeFileSync(process.argv[1] + '.ran', '');" });
  const result = doctor(repo);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), `FAIL  long-run deps (${FIX}): missing better-sqlite3`);
});

test('check --deps refuses (the ABI changed): FAIL with the fix and the cause, the CLI prefix and its own fix cut off', () => {
  const repo = checkout({ cli: `if (process.argv[2] !== 'check' || process.argv[3] !== '--deps') process.exit(9); console.error(${JSON.stringify(ABI_REFUSAL)}); process.exit(3);` });
  const result = doctor(repo);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), `FAIL  long-run deps (${FIX}): the SQLite module does not load (built for another Node ABI, this Node 26.5.0 needs 147)`);
});

test('check --deps crashes with no refusal line: FAIL with the fix and its error line', () => {
  const repo = checkout({ cli: "throw new Error('Cannot find package @langchain/core');" });
  const result = doctor(repo);
  assert.equal(result.status, 1);
  assert.match(result.stdout.trim(), new RegExp(`^FAIL  long-run deps \\(${FIX.replace(/[.;]/g, '\\$&')}\\): .*Error: Cannot find package @langchain/core`));
});

test('check --deps prints ok: the ok line', () => {
  const repo = checkout({ cli: "if (process.argv[3] !== '--deps') process.exit(9); console.log('ok');" });
  const result = doctor(repo);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout.trim(), 'ok    long-run deps');
});
