// Purpose: run the test command `land` gives a lane's rebased tip, in the lane's worktree, under one deadline.
// Exports: runTestCommand.
// Invariants:
// - The command is one string the caller typed, so it runs through the platform shell; stdin is closed.
// - Nothing it starts outlives it: on POSIX it leads its own process group and the deadline (or a Ctrl-C of `land`) kills the
//   whole group; on Windows `taskkill /T` kills the process tree.
// - It resolves, never rejects, and keeps only the end of the output, so a test that prints gigabytes cannot exhaust memory.
import { spawn, spawnSync } from 'node:child_process';

// The output kept while the test runs; far more than the lines `land` prints, so the last lines are always whole.
const OUTPUT_KEPT_BYTES = 1 << 20;
// How many of the last output lines a failure shows.
const TAIL_LINES = 40;
// Signals that end `land` itself: the test is killed first, since its own process group does not receive them.
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const MS_PER_SECOND = 1000;

/** Kills `child` and everything it started; a group that is already gone is not an error. */
function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error; // ESRCH: the group has already exited
  }
}

/** The last TAIL_LINES lines of `output`, without the empty line after a final newline. */
function lastLines(output) {
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-TAIL_LINES);
}

/** Why a finished test did not pass, or null when it passed (exit 0). */
function failureReason(status, signal) {
  if (status === 0) return null;
  return status === null ? `killed by ${signal}` : `exit ${status}`;
}

/**
 * Runs `command` in `cwd` and waits for it, at most `timeoutSeconds`.
 * Why: `land` must not fast-forward the base until the exact tip it lands has passed the lane's test, and a test that hangs
 * must neither block `land` for ever nor leave processes running in the lane's worktree.
 * @param {string} command the shell command, as typed
 * @param {string} cwd the lane's worktree, checked out at the tip to test
 * @param {number} timeoutSeconds the deadline; past it the test's processes are killed and the test counts as failed
 * @returns {Promise<{passed: boolean, reason: string | null, tail: string[]}>} `reason` says why it did not pass (null when it
 *   passed); `tail` holds the last 40 lines of its stdout and stderr together.
 */
export function runTestCommand(command, cwd, timeoutSeconds) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    const keep = (chunk) => {
      output = (output + chunk).slice(-OUTPUT_KEPT_BYTES);
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);

    let settled = false;
    let timer = null;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const signal of STOP_SIGNALS) process.off(signal, stopOnSignal);
      resolve({ passed: reason === null, reason, tail: lastLines(output) });
    };
    // Resolves from here, not from 'close': a process that left the group could hold the pipes open for ever.
    // Once the test has finished its pid may belong to another process, so it is never signalled then.
    const stop = (reason) => {
      if (settled) return;
      killTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
      finish(reason);
    };
    function stopOnSignal(signal) {
      stop(`stopped by ${signal} sent to land`);
    }

    timer = setTimeout(() => stop(`did not finish within ${timeoutSeconds} s; its processes were killed`), timeoutSeconds * MS_PER_SECOND);
    for (const signal of STOP_SIGNALS) process.once(signal, stopOnSignal);
    child.on('error', (error) => finish(`could not start: ${error.message}`));
    child.on('close', (status, signal) => finish(failureReason(status, signal)));
  });
}
