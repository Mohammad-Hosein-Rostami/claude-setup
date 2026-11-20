// Tests for the doctor checks check_node and check_claude_version (scripts/doctor.sh, DOCTOR_ONLY mode).
// The Bash guard's settings entry relies on `onFailure: "block"`, which Claude Code honours from 2.1.295; the guard's Windows path tests
// need module.registerHooks, which Node has from 22.15 (without it they are skipped). Doctor must fail on anything older, and must
// compare the parts as numbers: 2.1.99 is older than 2.1.295. The tools are fakes on PATH; HOME is a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const skip = process.platform === 'win32' ? 'the fake tools are sh scripts' : false;

/** Runs one doctor check with a fake `tool` on PATH that prints `output` whatever it is asked. */
function doctorWith(check, tool, output) {
  const bin = makeTempDir('doctor-bin-');
  const home = makeTempDir('doctor-home-');
  writeFileSync(join(bin, tool), `#!/bin/sh\necho '${output}'\n`);
  chmodSync(join(bin, tool), 0o755);
  const env = { ...process.env, HOME: home, USERPROFILE: home, DOCTOR_ONLY: check, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const run = spawnSync('bash', [DOCTOR], { encoding: 'utf8', env });
  return { status: run.status, out: run.stdout };
}

test('doctor fails on a Claude Code older than 2.1.295 and says what breaks', { skip }, () => {
  for (const version of ['2.1.294', '2.1.99', '2.0.400', '1.9.999']) {
    const { status, out } = doctorWith('check_claude_version', 'claude', `${version} (Claude Code)`);
    assert.equal(status, 1, version);
    assert.ok(out.includes(`FAIL  claude >= 2.1.295 required (found ${version})`), out);
    assert.match(out, /onFailure: block/);
  }
});

test('doctor accepts Claude Code 2.1.295 and later, and only warns when the CLI gives no version', { skip }, () => {
  for (const version of ['2.1.295', '2.1.329', '2.2.0', '3.0.0']) {
    const { status, out } = doctorWith('check_claude_version', 'claude', `${version} (Claude Code)`);
    assert.deepEqual([status, out.startsWith(`ok    claude ${version}`)], [0, true], out);
  }
  const silent = doctorWith('check_claude_version', 'claude', 'no version here');
  assert.deepEqual([silent.status, silent.out.startsWith('WARN  claude --version gave no version')], [0, true], silent.out);
});

test('doctor fails on a Node older than 22.15 and accepts 22.15 and later', { skip }, () => {
  for (const version of ['22.14.0', '22.9.1', '21.99.99', '20.19.0']) {
    const { status, out } = doctorWith('check_node', 'node', version);
    assert.equal(status, 1, version);
    assert.ok(out.includes(`FAIL  node >= 22.15 required (found ${version})`), out);
  }
  for (const version of ['22.15.0', '22.20.1', '24.0.0']) {
    const { status, out } = doctorWith('check_node', 'node', version);
    assert.deepEqual([status, out.trim()], [0, `ok    node ${version}`], version);
  }
});
