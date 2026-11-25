// Repro tests: a second stop signal while land's test runner (home/tools/land/run-test.mjs) is in the SIGTERM grace of the
// command's tree. The owner pressing Ctrl-C twice must not leave the
// tree behind: once the parent has exited, nothing of the command's group may be left.
// The commands are `sh` lines (POSIX only) that ignore SIGTERM, start a background sleep and write both pids to a file in the
// case's temp folder; every case SIGKILLs the parent and that group in a finally block.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { CLEAN_ENV } from './git-tidy-helpers.mjs';
import { POSIX_ONLY, isAlive, killGroupQuietly, readPids, waitUntil } from './process-group-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const RUN_TEST = pathToFileURL(join(import.meta.dirname, '..', 'home', 'tools', 'land', 'run-test.mjs')).href;
// The second Ctrl-C comes this long after the first: well inside the 3 s grace between SIGTERM and SIGKILL.
const SECOND_SIGNAL_AFTER_MS = 500;
// How long the command may take to write its pids, and a killed orphan to be reaped by init once the parent is gone.
const START_WAIT_MS = 10_000;
const GONE_WAIT_MS = 2000;
// A deadline far past the case's own end.
const NO_DEADLINE_SECONDS = 60;
// sh's script: $1 is the pid file; the background sleep inherits the shell's ignore of SIGTERM.
const IGNORING_TERM = "trap '' TERM; sleep 30 >/dev/null 2>&1 & echo $$ $! > \"$1\"; wait";

// Runs runTestCommand in its own node process and prints the result as JSON, so real signals can be sent to it.
const DRIVER = `import { runTestCommand } from ${JSON.stringify(RUN_TEST)};
const [command, cwd, timeoutSeconds] = process.argv.slice(2);
process.stdout.write(JSON.stringify(await runTestCommand(command, cwd, Number(timeoutSeconds))));
`;

/** Starts `argv` with piped output; `closed` resolves once it has exited and its pipes are closed. */
function startParent(argv, { cwd, env }) {
  const parent = spawn(process.execPath, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  parent.stdout.resume();
  parent.stderr.resume();
  const closed = new Promise((resolve) => { parent.on('close', (status, signal) => resolve({ status, signal })); });
  return { parent, closed };
}

/**
 * Waits for the command's pids, sends SIGINT twice (SECOND_SIGNAL_AFTER_MS apart), waits for the parent to exit.
 * @returns {Promise<number[]>} the command's shell and background pids.
 */
async function interruptTwice({ parent, closed }, pidFile) {
  const pids = await readPids(pidFile, START_WAIT_MS);
  parent.kill('SIGINT');
  await sleep(SECOND_SIGNAL_AFTER_MS);
  parent.kill('SIGINT');
  await closed;
  return pids;
}

/** SIGKILLs the group the command's shell led (its pid is the group id, and its background sleep is in it), if any is left. */
function cleanUp(pidFile) {
  if (existsSync(pidFile)) killGroupQuietly(Number(readFileSync(pidFile, 'utf8').trim().split(/\s+/)[0]));
}

test('land: a second SIGINT during the grace leaves nothing of the test command running once land has exited', POSIX_ONLY, async () => {
  const dir = makeTempDir('kill-tree-second-stop-');
  const pidFile = join(dir, 'pids');
  const driver = join(dir, 'driver.mjs');
  writeFileSync(driver, DRIVER);
  const started = startParent([driver, IGNORING_TERM.replace('"$1"', `'${pidFile}'`), dir, String(NO_DEADLINE_SECONDS)], { cwd: dir, env: CLEAN_ENV });
  try {
    const pids = await interruptTwice(started, pidFile);
    const gone = await waitUntil(() => pids.every((pid) => !isAlive(pid)), GONE_WAIT_MS);
    assert.ok(gone, `nothing of the command's group is left once land has exited (still running: ${pids.filter(isAlive).join(' ')})`);
  } finally {
    started.parent.kill('SIGKILL');
    cleanUp(pidFile);
  }
});
