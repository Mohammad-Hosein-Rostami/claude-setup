// The done-check's engine (design: sections 3.2, 3.3, 5, 6): runs the planned commands without a shell, in a pool of POOL_SIZE, under one
// total deadline, and turns each tool's own output (stdout, its result file, or stdout and stderr for go vet) into a CheckResult through
// parse.mjs, or go-parse.mjs for a command that names its Go reader (`cmd.parse`).
// Exports: runPlan.
// Invariants: every child runs in its own process group (POSIX) and the whole group is killed at the deadline, at its exit (strays) and when
//   this process exits; on Windows `taskkill /T /F` ends the tree. A result that cannot be read is not-run (error), never ok; a run
//   with 0 tests is `none`; a tool that prints more than MAX_OUTPUT_BYTES is read from its result file only, else not-run (error).
//   Nothing here throws for a bad command: a missing program, a crash or a bad file gives a not-run result for that command alone.
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { POOL_SIZE } from './contract.mjs';
import { parseGofmtList, parseGoTestJson, parseGoVet } from './go-parse.mjs';
import { parseEslintJson, parseJestJson, parseTap, parseTsc, parseVitestJson } from './parse.mjs';

const BYTES_PER_MIB = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * BYTES_PER_MIB; // what is kept of one tool's stdout; more is dropped (F1: a tool that prints 50 MB)
const MAX_RESULT_FILE_BYTES = 64 * BYTES_PER_MIB; // a tool's json result file bigger than this is not read
const EVERY_LINE = [[1, Number.MAX_SAFE_INTEGER]];
const TEST_PARSERS = { vitest: parseVitestJson, jest: parseJestJson };
// The Go commands name their reader (`cmd.parse`, lib/go-plan.mjs); go test needs the module path to turn import paths into folders.
const GO_PARSERS = { 'go-vet': (text) => parseGoVet(text), gofmt: (text) => parseGofmtList(text), 'go-test': (text, cmd) => parseGoTestJson(text, cmd.goModule ?? '') };
const STDERR_PARSERS = new Set(['go-vet']);

const slashed = (path) => path.replaceAll('\\', '/');
const notRun = (cmd, why, ms) => ({ kind: cmd.kind, label: cmd.label, result: 'not-run', ms, failures: [], why });

/** Which tool a `tests` command runs, from its label and argument names: vitest, jest, node (node --test) or null. */
function testToolOf(cmd) {
  const names = [cmd.label.split(' ')[0], ...cmd.argv.map((arg) => basename(arg).replace(/\.[cm]?js$/, ''))];
  if (names.includes('jest')) return 'jest';
  if (cmd.argv.includes('--test') || cmd.argv.some((arg) => arg.startsWith('--test-reporter'))) return 'node';
  return names.includes('vitest') ? 'vitest' : null;
}

/** Stops one child and everything it started: the process group on POSIX, `taskkill /T` on Windows. */
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL'); // the group is already gone (ESRCH) or not ours to signal: end the child itself, which is a no-op when dead
  }
}

/**
 * Starts one command and resolves when it ended, was killed by `abort`, or could not start. Never rejects.
 * @returns {{ done: Promise<{ code: number|null, signal: string|null, stdout: string, truncated: boolean, spawnFailed: boolean, timedOut: boolean }>, abort: () => void }}
 */
function startCommand(cmd) {
  const chunks = [];
  let kept = 0;
  let truncated = false;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  let finished = false;
  let child;
  const finish = (extra) => {
    if (finished) return;
    finished = true;
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    settle({ code: null, signal: null, truncated, spawnFailed: false, timedOut: false, ...extra, stdout: Buffer.concat(chunks).toString('utf8') });
  };
  const readsStderr = STDERR_PARSERS.has(cmd.parse);
  child = spawn(cmd.argv[0], cmd.argv.slice(1), { cwd: cmd.cwd, shell: cmd.shell, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', readsStderr ? 'pipe' : 'ignore'], windowsHide: true });
  const keep = (chunk) => {
    if (kept + chunk.length > MAX_OUTPUT_BYTES) { truncated = true; return; }
    kept += chunk.length;
    chunks.push(chunk);
  };
  child.stdout.on('data', keep);
  if (readsStderr) child.stderr.on('data', keep); // go vet prints its diagnostics on stderr; both streams share the one cap
  child.once('error', () => finish({ spawnFailed: true }));
  child.once('exit', () => killTree(child)); // a stray the tool left behind would hold the pipe open
  child.once('close', (code, signal) => finish({ code, signal }));
  return { done, abort: () => { killTree(child); finish({ timedOut: true }); }, kill: () => killTree(child) };
}

/** The tool's result text: its result file (a plain file under the size cap), or null when it is missing, a link or too big. */
function readResultFile(file) {
  try {
    const info = lstatSync(file);
    return info.isFile() && info.size <= MAX_RESULT_FILE_BYTES ? readFileSync(file, 'utf8') : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null; // the tool did not write it: "no result", answered as not-run (error)
    throw error;
  }
}

/** Runs `cmd` (already mapped into the folder it runs in) and returns its CheckResult; `lines` finds changed lines for lint. */
async function checkOne(cmd, running, lookupFor) {
  const started = Date.now();
  if (cmd.outputFile) rmSync(cmd.outputFile, { force: true }); // an old file must never be read as this run's result
  const run = startCommand(cmd);
  running.add(run);
  const ended = await run.done;
  running.delete(run);
  const ms = Date.now() - started;
  if (ended.timedOut) return notRun(cmd, 'time', ms);
  if (ended.spawnFailed || ended.signal !== null) return notRun(cmd, 'error', ms); // could not start, or killed mid-write by a signal
  const resultText = cmd.outputFile ? readResultFile(cmd.outputFile) : ended.truncated ? null : ended.stdout;
  if (resultText === null) return notRun(cmd, 'error', ms); // no result file, or output cut at the cap: even exit 0 is not a pass
  const parsed = await parseFor(cmd, resultText, lookupFor);
  const verdict = judge(cmd, parsed, ended.code);
  return { kind: cmd.kind, label: cmd.label, ms, failures: parsed?.failures ?? [], ...(parsed ? { total: parsed.total } : {}), ...verdict };
}

async function parseFor(cmd, text, lookupFor) {
  if (text === null) return null;
  if (cmd.parse) return Object.hasOwn(GO_PARSERS, cmd.parse) ? GO_PARSERS[cmd.parse](text, cmd) : null;
  if (cmd.kind === 'types') return parseTsc(text);
  if (cmd.kind === 'lint') return parseEslintJson(text, await lookupFor());
  const tool = testToolOf(cmd);
  if (tool === 'node') return parseTap(text, cmd.argv.length > 0 ? slashed(cmd.argv[cmd.argv.length - 1]) : '');
  return tool ? TEST_PARSERS[tool](text) : null;
}

/** Result and why from what was read and the exit code. Only a clean read of an exit-0 tool, or a clean read with failures, is trusted. */
function judge(cmd, parsed, code) {
  if (cmd.kind === 'types' && !parsed) return code === 0 ? { result: 'ok', total: 0 } : { result: 'not-run', why: 'error' };
  if (!parsed) return { result: 'not-run', why: 'error' };
  if (parsed.failures.length > 0) return { result: 'fail' };
  if (cmd.kind === 'tests' && code !== 0) return { result: 'not-run', why: 'error' }; // red exit but no failing test named: unknown cause
  if (cmd.parse === 'gofmt' && code !== 0) return { result: 'not-run', why: 'error' }; // gofmt could not read a file (a syntax error): not clean
  return { result: cmd.kind === 'tests' && parsed.total === 0 ? 'none' : 'ok' };
}

/** Makes tool paths repo-relative: absolute ones under `roots`, relative ones (printed from `cwd`) joined to the package folder. */
function repoRelative(file, roots, packagePrefix) {
  const path = slashed(file);
  const root = roots.find((one) => path.toLowerCase().startsWith(`${one.toLowerCase()}/`));
  if (root) return path.slice(root.length + 1);
  return /^([A-Za-z]:)?\//.test(path) || path === '' ? path : slashed(join(packagePrefix, path));
}

function relativeFailures(result, roots, packagePrefix) {
  const failures = result.failures.map((failure) => {
    const file = repoRelative(failure.file, roots, packagePrefix);
    return { ...failure, file, id: failure.id.startsWith(`${failure.file}|`) ? `${file}${failure.id.slice(failure.file.length)}` : failure.id, text: failure.text.replace(failure.file, file) };
  });
  return { ...result, failures };
}

/** Lookup of changed lines for eslint: all lines without a git base, else scope.mjs `changedLines` of each changed file (read once). */
function changedLinesLookup(scope, roots) {
  let loaded;
  return () => {
    loaded ??= (async () => {
      if (!scope.git || !scope.base) return () => EVERY_LINE;
      const { changedLines } = await import('./scope.mjs');
      const entries = await Promise.all(scope.files.map(async (file) => [file, await changedLines(scope.top, scope.base, file)]));
      const byFile = new Map(entries);
      return (file) => byFile.get(repoRelative(file, roots, '')) ?? [];
    })();
    return loaded;
  };
}

/**
 * Runs every command of `plan` and reads each result. At most POOL_SIZE commands run at once; one deadline covers the whole call: at
 * it every running command is killed with its process group and every command not started is `not-run (time)`.
 * @param {import('./contract.mjs').Plan} plan what to run
 * @param {import('./contract.mjs').Scope} scope the change (top folder, git base, changed files)
 * @param {{ deadlineMs: number, dir?: string }} options `deadlineMs` total wall-clock cap; `dir` runs the commands in that copy of the tree (the base copy) instead of `scope.top`
 * @returns {Promise<import('./contract.mjs').CheckResult[]>} one result per command, in plan order (the caller merges them per kind)
 * @throws {RangeError} when `deadlineMs` is not a positive number
 */
export async function runPlan(plan, scope, { deadlineMs, dir }) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new RangeError(`runPlan: deadlineMs must be a positive number, got ${deadlineMs}`);
  const top = scope.top ?? '';
  const target = dir ?? top;
  const inTarget = (value) => (typeof value === 'string' && top && dir && (value === top || value.startsWith(top + sep)) ? join(dir, relative(top, value)) : value);
  const roots = [...new Set([slashed(target), slashed(realpathOr(target))])];
  const cmds = plan.packages.flatMap((one) => one.cmds).map((cmd) => ({ ...cmd, argv: cmd.argv.map(inTarget), cwd: inTarget(cmd.cwd), ...(cmd.outputFile ? { outputFile: inTarget(cmd.outputFile) } : {}) }));
  const lookupFor = changedLinesLookup(scope, roots);
  const results = new Array(cmds.length);
  const running = new Set();
  const killAll = () => running.forEach((run) => run.kill());
  let expired = false;
  let next = 0;
  const worker = async () => {
    while (next < cmds.length) {
      const index = next++;
      results[index] = expired ? notRun(cmds[index], 'time', 0) : await guarded(cmds[index], running, lookupFor, roots, target);
    }
  };
  const timer = setTimeout(() => { expired = true; [...running].forEach((run) => run.abort()); }, deadlineMs);
  process.once('exit', killAll); // a hook killed from outside must not leave its tools running
  try {
    await Promise.all(Array.from({ length: Math.min(POOL_SIZE, cmds.length) }, worker));
  } finally {
    clearTimeout(timer);
    process.removeListener('exit', killAll);
  }
  return results;
}

const realpathOr = (path) => { try { return realpathSync(path); } catch { return path; } };

async function guarded(cmd, running, lookupFor, roots, target) {
  const started = Date.now();
  try {
    const result = await checkOne(cmd, running, lookupFor);
    const prefix = relative(target, cmd.cwd); // tools print relative paths from their own folder
    return relativeFailures(result, roots, prefix);
  } catch {
    return notRun(cmd, 'error', Date.now() - started); // a command that blew up (bad cwd type, unreadable result file) fails alone
  }
}
