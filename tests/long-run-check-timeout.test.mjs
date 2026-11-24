// Repro test for the step check's deadline (home/tools/long-run/lib/step-start.mjs, runCheck): a check that is stopped at its
// timeout has not passed, even when it exits 0 on the SIGTERM that stops it.
// The driver runs in this process with the fake claude of long-run-fake-claude.mjs (long-run-helpers.mjs). The check's deadline
// is a real timer of at least 1 minute (job.mjs allows whole minutes only), so this case takes about a minute.
// The check is an `sh` line (POSIX only) that writes its pids to the sandbox; the case SIGKILLs that group in a finally block.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRun, driveRun, makeSandbox, stdinsOf } from './long-run-helpers.mjs';
import { POSIX_ONLY, killGroupQuietly } from './process-group-helpers.mjs';

// The shortest check deadline a job may set, and the test's own limit: the deadline, the 3 s grace and the two fake sessions.
const CHECK_TIMEOUT_MINUTES = 1;
const CASE_TIMEOUT_MS = 90_000;

/**
 * The check: its first run traps SIGTERM to exit 0 and waits on a sleep far past the deadline; every later run passes at once
 * (so the step can end after the follow-up). `$$ $!` go to `pidFile` for the cleanup.
 */
const hangingThenPassingCheck = (pidFile) => [
  'if [ -f checked-once ]; then exit 0; fi;',
  'touch checked-once;',
  "trap 'exit 0' TERM;",
  'sleep 120 >/dev/null 2>&1 &',
  `echo $$ $! > '${pidFile}';`,
  'wait',
].join(' ');

test('a check stopped at its timeout that exits 0 on the SIGTERM counts as failed: the session gets the check-failed follow-up', { ...POSIX_ONLY, timeout: CASE_TIMEOUT_MS }, async () => {
  const box = makeSandbox();
  const pidFile = join(box.dir, 'check-pids');
  const check = { command: hangingThenPassingCheck(pidFile), timeoutMinutes: CHECK_TIMEOUT_MINUTES };
  const paths = createRun(box, { name: 'check-timeout', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'Do one.', check }] });
  try {
    assert.equal(await driveRun(box, paths), 'done');
    const stdins = stdinsOf(box, 'one');
    assert.equal(stdins.length, 2, 'the timed-out check did not count as passed: the session was resumed once');
    assert.match(stdins[1], /^The step check `.*` failed \(exit -?\d+\)\. Last 40 lines:\n.*\(check stopped after 1 min\)\nFix it and finish\.$/s);
  } finally {
    if (existsSync(pidFile)) killGroupQuietly(Number(readFileSync(pidFile, 'utf8').trim().split(/\s+/)[0]));
  }
});
