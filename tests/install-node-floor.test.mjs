// Tests for the one Node floor (audit H19): scripts/install.sh, scripts/install.ps1 and doctor's check_node hold the same
// major.minor floor, install.sh refuses a Node below it and runs the installer on it, and install.ps1 checks jq before it runs.
// Exports: none (node:test file). install.sh runs with a fake `node` first on PATH (a sh script: POSIX only); install.ps1 is
// read, not run (no PowerShell on the Mac and Linux machines that run the suite).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url));
const read = (...parts) => readFileSync(join(SCRIPTS, ...parts), 'utf8');
const posix = { skip: process.platform === 'win32' && 'the fake node is a sh script' };
const RAN = 'fake install.mjs ran';

/** The floor each file sets, by its own assignment line. */
function floors() {
  return {
    'install.sh': /^NODE_FLOOR=(\d+\.\d+)$/m.exec(read('install.sh'))?.[1],
    'install.ps1': /^\$NODE_FLOOR = \[version\]'(\d+\.\d+)'$/m.exec(read('install.ps1'))?.[1],
    'doctor/checks-machine.sh': /^NODE_FLOOR=(\d+\.\d+)$/m.exec(read('doctor', 'checks-machine.sh'))?.[1],
  };
}

/** One fake node for every case (a new executable is slow to start the first time on macOS): it prints $FAKE_NODE_VERSION to
 * `node -p` and stands in for install.mjs otherwise. */
const fakeBin = makeTempDir('node-floor-');
writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\nif [ "$1" = "-p" ]; then echo "$FAKE_NODE_VERSION"; else echo "${RAN}"; fi\n`);
chmodSync(join(fakeBin, 'node'), 0o755);

/** Runs install.sh --dry-run with the fake node reporting `version`. */
function installWithNode(version) {
  const env = cleanEnv({ PATH: `${fakeBin}:${process.env.PATH}`, FAKE_NODE_VERSION: version });
  return spawnSync('bash', [join(SCRIPTS, 'install.sh'), '--dry-run'], { env, encoding: 'utf8' });
}

test('install.sh, install.ps1 and doctor hold one Node floor, 22.15', () => {
  assert.deepEqual(floors(), { 'install.sh': '22.15', 'install.ps1': '22.15', 'doctor/checks-machine.sh': '22.15' });
});

test('install.sh refuses a Node below the floor and names it', posix, () => {
  for (const version of ['22.14.0', '22.9.9', '21.99.0', '20.19.0']) {
    const run = installWithNode(version);
    assert.equal(run.status, 1, version);
    assert.equal(run.stderr.trim(), `node ${version} found; the setup needs node 22.15+`, version);
    assert.ok(!run.stdout.includes(RAN), `${version}: the installer must not run`);
  }
});

test('install.sh runs the installer on the floor and above', posix, () => {
  for (const version of ['22.15.0', '22.20.1', '23.0.0', '24.1.0']) {
    const run = installWithNode(version);
    assert.equal(run.status, 0, `${version}: ${run.stderr}`);
    assert.equal(run.stdout.trim(), RAN, version);
  }
});

test('install.ps1 checks jq before it runs install.mjs, except for -Uninstall', () => {
  const ps1 = read('install.ps1');
  const jqCheck = ps1.indexOf('if (-not $Uninstall -and -not (Get-Command jq -ErrorAction SilentlyContinue))');
  assert.ok(jqCheck > 0, 'the jq check');
  assert.ok(ps1.includes("Write-Error 'missing required tool: jq (winget install jqlang.jq)'; exit 1"), 'its message and exit');
  assert.ok(jqCheck < ps1.indexOf('& node @argList'), 'before the installer runs');
});
