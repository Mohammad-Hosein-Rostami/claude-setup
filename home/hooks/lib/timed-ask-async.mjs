// The timed native dialog of lib/timed-ask.mjs as a promise, so it can be closed from outside.
// Exports: answerAskAsync(request, env, {signal, platform, now}) -> Promise<{decision, outcome, reason}>, closeLiveDialogs(), installDialogCleanup().
// Why: a dialog run with spawnSync blocks the hook, so it cannot notice that the owner already answered in the terminal and cannot stop
// its popup when Claude Code stops the hook (the dialog tool is a separate child that outlives the hook). Here the dialog runs with `spawn`:
// aborting `signal` kills it and the answer is outcome "closed" (decision "ask": the caller leaves the question to Claude Code); every
// dialog still open is killed by closeLiveDialogs(), which installDialogCleanup() runs when the process gets SIGTERM, SIGINT or SIGHUP
// and when it exits. The dialog text, the buttons and the mapping of the answer come from lib/timed-ask.mjs.
// Invariants: never rejects; a "timeout" is only believed after the full wait; the dialog tool also gives up by itself at its own timeout.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { maskSecrets } from './secrets.mjs';
import { ALLOW_DENY_BUTTONS, answerFromOutcome, askTimeoutSeconds, guiAvailable, parseDialogResult, requestInvocation } from './timed-ask.mjs';

const MS_PER_SECOND = 1000;
const SPAWN_GRACE_S = 5; // the dialog tool gives up by itself at the timeout; this only stops one that hangs
const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const CONVENTIONAL_SIGNAL_EXIT = 128; // a process stopped by signal N exits with 128 + N by convention
const liveDialogs = new Set(); // child processes of the dialogs still open
const closedOnPurpose = new WeakSet(); // dialogs killed by closeLiveDialogs or an abort, not by a crash or the hung-dialog timer

/** Kills a dialog and remembers that it was closed on purpose. */
function closeDialog(child) {
  closedOnPurpose.add(child);
  child.kill();
}

/** Kills every dialog this process still has open; each pending answerAskAsync then reports "closed". */
export function closeLiveDialogs() {
  for (const child of liveDialogs) closeDialog(child);
  liveDialogs.clear();
}

/**
 * Makes a stopped hook take its popups with it: kills the open dialogs on SIGTERM, SIGINT, SIGHUP (then exits like the signal says) and on exit.
 * @returns {void}
 */
export function installDialogCleanup() {
  process.on('exit', closeLiveDialogs);
  for (const signal of STOP_SIGNALS) {
    process.on(signal, () => {
      closeLiveDialogs();
      process.exit(CONVENTIONAL_SIGNAL_EXIT + constants.signals[signal]);
    });
  }
}

/**
 * Runs the dialog tool and collects what it printed.
 * @returns {Promise<{status: number | null, signal: string | null, stdout: string, stderr: string, closed: boolean, error?: Error}>} the finished child, or its spawn error
 */
function runDialog(invocation, env, timeoutS, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, { env: { ...env, ...invocation.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', closed: false, error });
      return;
    }
    liveDialogs.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const stopHungDialog = setTimeout(() => child.kill(), (timeoutS + SPAWN_GRACE_S) * MS_PER_SECOND);
    const closeFromOutside = () => closeDialog(child);
    signal?.addEventListener('abort', closeFromOutside, { once: true });
    const finish = (result) => {
      clearTimeout(stopHungDialog);
      signal?.removeEventListener('abort', closeFromOutside);
      liveDialogs.delete(child);
      resolve({ stdout, stderr, closed: closedOnPurpose.has(child), ...result });
    };
    child.on('error', (error) => finish({ status: null, signal: null, error }));
    child.on('close', (status, killedBy) => finish({ status, signal: killedBy }));
  });
}

/**
 * Asks the owner through a native dialog that an abort signal can close.
 * @param {object} request what to show (lib/timed-ask-text.mjs dialogText), with its title, buttons and timeoutS
 * @param {Record<string, string | undefined>} env process environment (timeout, ssh/CI detection, PATH)
 * @param {{signal?: AbortSignal, platform?: string, now?: () => number}} options `signal` closes the dialog (answer "closed"); `now` is the clock in milliseconds
 * @returns {Promise<{decision: 'allow' | 'deny' | 'ask', outcome: 'allow' | 'deny' | 'timeout' | 'no-gui' | 'dialog-failed' | 'closed', reason: string}>}
 */
export async function answerAskAsync(request, env = process.env, { signal, platform = process.platform, now = () => performance.now() } = {}) {
  const reason = maskSecrets(String(request.reason));
  if (!guiAvailable(env, platform)) return { decision: 'ask', outcome: 'no-gui', reason };
  if (signal?.aborted) return { decision: 'ask', outcome: 'closed', reason };
  const timeoutS = request.timeoutS ?? askTimeoutSeconds(env);
  const invocation = requestInvocation(request, timeoutS, platform);
  if (!invocation) return answerFromOutcome('unavailable', { reason, timeoutS, waitedMs: 0 });
  const started = now();
  const result = await runDialog(invocation, env, timeoutS, signal);
  if (result.closed) return { decision: 'ask', outcome: 'closed', reason };
  const outcome = result.error || result.signal || result.status === null ? 'unavailable' : parseDialogResult(platform, result, request.buttons ?? ALLOW_DENY_BUTTONS);
  return answerFromOutcome(outcome, { reason, timeoutS, waitedMs: now() - started });
}
