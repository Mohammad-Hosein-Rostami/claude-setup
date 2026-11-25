// Runs one child of a scenario (a `claude -p`, git, land, suite, long-run) detached, with a wall-clock timeout, its output
// redacted line by line into files. Exports: runDetached(spec), runQuick(command, args, options).
// Why: the runner stays in the foreground while each long step runs as a detached child (its own process group, so a timeout or
// a usage limit ends all of it); stdout and stderr go through the redactor before they reach a file, so no log holds a token.
// Invariants: never a shell (argv only); the child is registered with the run's ProcessRegistry before any output is read; a
// timeout or an abort ends the child's group (TERM, then KILL) and the result says which; `onLine` sees each redacted stdout line
// (the stream-json events) and may return 'stop' to end the child at once (a usage limit); `onSpawn` gets the child's pid.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { redact } from './redact.mjs';

const DRAIN_MS = 5_000;

/**
 * @param {{command: string, args: string[], env: object, cwd: string, outFile: string, errFile: string, timeoutMs: number,
 *   registry: import('./processes.mjs').ProcessRegistry, onLine?: (line: string) => 'stop' | void, signal?: AbortSignal,
 *   onSpawn?: (pid: number) => void}} spec
 * @returns {Promise<{code: number | null, signal: string | null, timedOut: boolean, stopped: boolean, durationMs: number,
 *   startError: string | null}>}
 */
export function runDetached({ command, args, env, cwd, outFile, errFile, timeoutMs, registry, onLine = () => {}, signal, onSpawn = () => {} }) {
  const startedMs = Date.now();
  const out = openSync(outFile, 'a', 0o600);
  const err = openSync(errFile, 'a', 0o600);
  return new Promise((resolve) => {
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let drain = null;
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    registry.add(child.pid);
    if (child.pid) onSpawn(child.pid);
    const endChild = () => { if (child.pid) void registry.end(child.pid); };
    const timer = setTimeout(() => { timedOut = true; endChild(); }, timeoutMs);
    const onAbort = () => { stopped = true; endChild(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const finish = (code, exitSignal, startError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      signal?.removeEventListener('abort', onAbort);
      if (child.pid) registry.settle(child.pid);
      closeSync(out);
      closeSync(err);
      resolve({ code, signal: exitSignal, timedOut, stopped, durationMs: Date.now() - startedMs, startError });
    };
    createInterface({ input: child.stdout }).on('line', (raw) => {
      if (settled) return;
      const line = redact(raw);
      writeSync(out, `${line}\n`);
      if (onLine(line) === 'stop') onAbort();
    });
    createInterface({ input: child.stderr }).on('line', (raw) => { if (!settled) writeSync(err, `${redact(raw)}\n`); });
    child.on('error', (error) => finish(null, null, error.code === 'ENOENT' ? `${command} is not on PATH` : redact(error.message)));
    child.on('close', (code, exitSignal) => finish(code, exitSignal));
    // a process the child left behind can hold its pipes open, so 'close' never fires: the exit counts after a short drain
    child.on('exit', (code, exitSignal) => {
      drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code, exitSignal); }, DRAIN_MS);
    });
  });
}

/**
 * A short step (git init, a commit, a status read) in the foreground, with a timeout.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: object, timeoutMs?: number, input?: string}} options
 * @returns {{code: number | null, stdout: string, stderr: string}} the output redacted
 */
export function runQuick(command, args, { cwd, env, timeoutMs = 60_000, input } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, input, windowsHide: true });
  return { code: result.status, stdout: redact(result.stdout ?? ''), stderr: redact(result.stderr ?? result.error?.message ?? '') };
}
