// Runs one `claude -p` of a scenario and reads what it printed. Exports: runClaude(spec).
// Why: every real run goes through here, so each one is detached with the scenario's remaining wall-clock time, its stream is
// redacted into a file, and a usage limit (or usage credits in use) seen in any line stops the whole run at once (plan section 9:
// stop every scenario, print the reset time, never retry).
// Invariants: the argv comes from models.mjs claudeArgs (the caller passes it; this module never builds one); `onLimit` is called
// at most once per run of claude, with the first limit seen in the stream, else one found in the stream or stderr afterwards.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelOfArgs } from './models.mjs';
import { runDetached } from './spawn.mjs';
import { initOf, limitLine, limitOf, readStream, resultOf, sessionIdOf } from './stream.mjs';

const STDERR_TAIL_CHARS = 2_000;

const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

/**
 * @param {{name: string, args: string[], cwd: string, env: object, dir: string, timeoutMs: number,
 *   registry: import('./processes.mjs').ProcessRegistry, signal: AbortSignal, onLimit: (limit: object) => void}} spec
 *   `args` from claudeArgs; `dir` the scenario's log folder; `name` a fixed literal of the scenario (it names the files)
 * @returns {Promise<{name: string, args: string[], model: string | null, cwd: string, events: object[], init: object | null,
 *   result: object | null, sessionId: string | null, exit: object, limit: object | null, stderrTail: string, outFile: string,
 *   errFile: string}>}
 */
export async function runClaude({ name, args, cwd, env, dir, timeoutMs, registry, signal, onLimit }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const outFile = join(dir, `${name}.stream.jsonl`);
  const errFile = join(dir, `${name}.stderr.log`);
  let limit = null;
  const exit = await runDetached({
    command: 'claude', args, env, cwd, outFile, errFile, timeoutMs, registry, signal,
    onLine: (line) => {
      if (limit !== null) return undefined;
      let event;
      try { event = JSON.parse(line); } catch { return undefined; }
      limit = limitLine(event);
      if (limit === null) return undefined;
      onLimit(limit);
      return 'stop';
    },
  });
  const events = readStream(outFile);
  const stderr = readText(errFile);
  if (limit === null) {
    limit = limitOf(events, stderr);
    if (limit !== null) onLimit(limit);
  }
  return {
    name, args, model: modelOfArgs(args), cwd, events, init: initOf(events), result: resultOf(events), sessionId: sessionIdOf(events),
    exit, limit, stderrTail: stderr.slice(-STDERR_TAIL_CHARS), outFile, errFile,
  };
}
