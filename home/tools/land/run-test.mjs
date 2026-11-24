// Purpose: run the test command `land` gives a lane's rebased tip, in the lane's worktree, under one deadline.
// Exports: runTestCommand, MAX_TIMEOUT_SECONDS.
// Invariants:
// - The command is one string the caller typed, so it runs through the platform shell; stdin is closed.
// - Nothing it starts outlives it: on POSIX it leads its own process group, and the whole group is ended (SIGTERM, then
//   SIGKILL after a grace, `../long-run/lib/process-tree.mjs`) when the command ends (pass or fail), at the deadline and on a
//   Ctrl-C of `land`; on Windows `taskkill /T /F` kills the process tree. The result comes once the group is gone. A second
//   stop signal during the grace sends SIGKILL to the group at once, so pressing Ctrl-C twice still leaves nothing running.
// - It resolves, never rejects, and keeps only the end of the output, so a test that prints gigabytes cannot exhaust memory.
import { spawn } from 'node:child_process';
import { endProcessTree, signalProcessTree } from '../long-run/lib/process-tree.mjs';

// The output kept while the test runs; far more than the lines `land` prints, so the last lines are always whole.
const OUTPUT_KEPT_BYTES = 1 << 20;
// How many of the last output lines a failure shows.
const TAIL_LINES = 40;
// Signals that end `land` itself: the test is killed first, since its own process group does not receive them.
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const MS_PER_SECOND = 1000;
// After the command exits, how long its last output may take to arrive; a process outside its group may hold the pipes open.
const OUTPUT_DRAIN_MS = 2000;
/** The longest deadline a timer can hold (2^31 - 1 ms, about 24.8 days); a longer one would fire at once. */
export const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / MS_PER_SECOND);

/**
 * Ends `child` and everything it started. A kill error is returned as a reason rather than thrown, since runTestCommand never
 * rejects, and a tree that cannot be ended must not count as a pass.
 * @returns {Promise<string | null>} why the tree could not be ended, or null when it was.
 */
function endTree(child) {
  return endProcessTree(child).then(() => null, (error) => `its processes could not be killed: ${error.message}`);
}

/** The reasons that are not null, joined; null when there are none (the test passed). */
const joinReasons = (...reasons) => reasons.filter((reason) => reason !== null).join('; ') || null;

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
 * Why: `land` must not fast-forward the base until the exact tip it lands has passed the lane's test, and a test must neither
 * block `land` for ever nor leave processes running in the lane's worktree.
 * @param {string} command the shell command, as typed
 * @param {string} cwd the lane's worktree, checked out at the tip to test
 * @param {number} timeoutSeconds the deadline, at most MAX_TIMEOUT_SECONDS; past it the test's processes are killed and the test
 *   counts as failed
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
    // The tree is ended once, by whichever comes first: a stop, or the command's own exit.
    let ending = false;
    // Why a stop (the deadline, or a signal to `land`) ended the test; it wins over the command's own exit, so a Ctrl-C
    // while the tree of a passed test is being ended still keeps the lane from landing.
    let stopReason = null;
    let deadline = null;
    let drain = null;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(drain);
      for (const signal of STOP_SIGNALS) process.off(signal, stopOnSignal);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ passed: reason === null, reason, tail: lastLines(output) });
    };
    // Once the test has settled its pid may belong to another process, so it is never signalled then.
    const stop = (reason) => {
      if (settled) return;
      if (stopReason !== null) {
        // A second stop during the grace: no more waiting; the tree's end is seen at the next poll and settles the test.
        signalProcessTree(child, 'SIGKILL');
        return;
      }
      stopReason = reason;
      clearTimeout(deadline);
      if (ending) return; // the command has exited and its tree is already being ended; that path settles the test
      ending = true;
      endTree(child).then((killError) => finish(joinReasons(stopReason, killError)));
    };
    function stopOnSignal(signal) {
      stop(`stopped by ${signal} sent to land`);
    }

    deadline = setTimeout(() => stop(`did not finish within ${timeoutSeconds} s; its processes were killed`), timeoutSeconds * MS_PER_SECOND);
    for (const signal of STOP_SIGNALS) process.on(signal, stopOnSignal);
    child.on('error', (error) => finish(`could not start: ${error.message}`));
    child.on('exit', (status, signal) => {
      if (ending) return; // a stop is already ending the tree and settles the test
      ending = true;
      const reason = failureReason(status, signal);
      clearTimeout(deadline);
      // Whatever the test left running in the background dies with it, and so stops holding the output pipes open.
      const treeEnded = endTree(child);
      // 'close' follows once the last output is read; a process that left the group could delay it for ever.
      const outputRead = new Promise((resolveRead) => {
        child.on('close', resolveRead);
        drain = setTimeout(resolveRead, OUTPUT_DRAIN_MS);
      });
      Promise.all([treeEnded, outputRead]).then(([killError]) => finish(joinReasons(stopReason ?? reason, killError)));
    });
  });
}
