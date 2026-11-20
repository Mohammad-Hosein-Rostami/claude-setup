// Tests for home/hooks/lib/owner-process.mjs: the real `ps` call (the walk and its budget are tested with a fake lookup in
// tests/mode.test.mjs and tests/project-agents-timed.test.mjs). Security review 1 of lane r9-mode-fix (round 9), S3: `ps` is found
// through PATH, and one that ignored SIGTERM held the hook 9 s, past its timeout. No test measures time: a planted `ps` that
// outlives its kill signal leaves a marker file. A newly written script takes up to 2 s to start the first time on macOS (measured:
// 350 to 2,086 ms, then 3 to 6 ms), so every planted `ps` is run once with the argument `warm` before the lookup that counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PS_TIMEOUT_MS, psLookup } from '../home/hooks/lib/owner-process.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const EXECUTABLE = 0o755;
const PS_CUT_MS = PS_TIMEOUT_MS / 2; // long enough for the warmed-up script to start and set its trap
const LATE_END_S = 2; // when a ps that survived its kill signal would end by itself

/** Runs `psLookup` with `source` planted as the `ps` that PATH finds. */
function lookupWith(source, timeoutMs) {
  const bin = makeTempDir('owner-ps-');
  writeFileSync(join(bin, 'ps'), `#!/bin/sh\n[ "$1" = warm ] && exit 0\n${source}\n`, { mode: EXECUTABLE });
  execFileSync(join(bin, 'ps'), ['warm']);
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    return psLookup(process.pid, timeoutMs);
  } finally {
    process.env.PATH = path;
  }
}

test('psLookup reads one line `<ppid> <command>` from the ps that PATH finds, and nothing from any other answer', { skip: process.platform === 'win32' && 'Windows has no ps' }, () => {
  assert.deepEqual(lookupWith("echo '  42 /usr/local/bin/claude'", PS_TIMEOUT_MS), { ppid: 42, command: '/usr/local/bin/claude' });
  assert.equal(lookupWith("printf '1 claude\\n2 sh\\n'", PS_TIMEOUT_MS), undefined, 'two lines');
  assert.equal(lookupWith('exit 1', PS_TIMEOUT_MS), undefined, 'ps failed');
});

test('a ps that ignores SIGTERM is ended at its timeout by a signal it cannot ignore', { skip: process.platform === 'win32' && 'Windows has no ps' }, () => {
  const survived = join(makeTempDir('owner-ps-'), 'survived-its-kill');
  assert.equal(lookupWith(`trap '' TERM\n/bin/sleep ${LATE_END_S}\n: > "${survived}"`, PS_CUT_MS), undefined);
  assert.equal(existsSync(survived), false, 'the planted ps did not live on to its own end');
});
