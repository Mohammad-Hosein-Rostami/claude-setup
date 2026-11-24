#!/usr/bin/env node
// Purpose: run a test suite through one machine-wide queue with a pass cache, and pick the tests a change can affect, so parallel
//   lanes neither overload the machine nor run the same suite on the same tree twice.
// Usage:
//   node ~/.claude/tools/suite/suite.mjs run [--repo <dir>] [--slots <n>] [--cache [--fresh]] [--log <file>] -- <command> [args...]
//   node ~/.claude/tools/suite/suite.mjs related [--repo <dir>] --base <ref> [--tip <ref>]
//   node ~/.claude/tools/suite/suite.mjs status
// Exports: none (a CLI). Exit codes: run: the command's exit (128 + signal number when a signal ended it; 0 on a cache hit);
//   related and status: 0; 2 for a usage error, a bad config file, a bad ref or a folder that is not a repository.
// Invariants:
// - The command runs as argv, never through a shell, in the repo folder, in its own process group; SIGINT, SIGTERM and SIGHUP end
//   that group (SIGTERM, then SIGKILL after a grace, `../long-run/lib/process-tree.mjs`) before the exit, a second one during
//   the grace sends SIGKILL at once and exits, any other exit sends it SIGTERM, and the slot is freed.
// - The pass cache is opt-in (`--cache`, for test runs only: an install or a build has effects a cached pass would skip). A pass is
//   cached only when the tree was clean before and after the run and did not change; a failure is never cached.
// - State lives in `$CLAUDE_CONFIG_DIR/state/suite/` (else `~/.claude/state/suite/`): one queue for every session on the machine.
//   It holds only locks, the cache and logs, so it can be deleted at any time.
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runGit } from '../git-tidy/lib/git.mjs';
import { endProcessTree, signalProcessTree } from '../long-run/lib/process-tree.mjs';
import { rangeScope } from '../risk/lib/range.mjs';
import { CACHE_KEEP_MS, cacheKey, lookup, recordPass, removeOlderThan } from './lib/cache.mjs';
import { acquireSlot, queueState } from './lib/queue.mjs';
import { relatedTests } from './lib/related.mjs';

const USAGE = [
  'usage: node ~/.claude/tools/suite/suite.mjs run [--repo <dir>] [--slots <n>] [--cache [--fresh]] [--log <file>] -- <command> [args...]',
  '       node ~/.claude/tools/suite/suite.mjs related [--repo <dir>] --base <ref> [--tip <ref>]',
  '       node ~/.claude/tools/suite/suite.mjs status',
].join('\n');
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const DEFAULT_CONFIG = { slots: 1, cache: true }; // slots: measured, see README.md "How many suites at once"
const MAX_SLOTS = 64;
const EXIT_CANNOT_START = 127; // as a shell reports a command it cannot find
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// An `exit` handler cannot wait out a grace, so it sends one signal: SIGTERM on POSIX; on Windows a forced `taskkill /F`
// (signalProcessTree's SIGKILL), the only kind that ends a console program there.
const EXIT_SIGNAL = process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM';
const FAILURE_TAIL_LINES = 40;
const TAIL_BYTES = 256 * 1024; // the summary and the last 40 lines are at the end; a huge log is never read whole
const TREE_PREFIX = 12; // the tree sha's length in the `cached PASS` line
// node:test's closing lines (spec reporter): `ℹ tests 2471`, `ℹ pass 2470`, `ℹ fail 1`, `ℹ duration_ms 173000.5`, ...
const SUMMARY_LINE = /^ℹ (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \d/;

/** A mistake in the arguments or the config file: printed with the usage, exit 2. */
class UsageError extends Error {}

const stateFolder = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'state', 'suite');

/** `state/suite/config.json` merged over DEFAULT_CONFIG; a file that is not `{ "slots"?: 1..64, "cache"?: boolean }` throws. */
function readConfig(stateDir) {
  let text;
  try {
    text = readFileSync(join(stateDir, 'config.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_CONFIG;
    throw error;
  }
  let config;
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(text) };
  } catch (error) {
    throw new UsageError(`${join(stateDir, 'config.json')} is not valid JSON: ${error.message}`);
  }
  if (!isSlotCount(config.slots) || typeof config.cache !== 'boolean') {
    throw new UsageError(`${join(stateDir, 'config.json')} must be { "slots": <1..${MAX_SLOTS}>, "cache": <true|false> }`);
  }
  return config;
}

const isSlotCount = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_SLOTS;

/** The options and the command of `run`: the command is everything after `--`. */
function readRunArgs(args) {
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) throw new UsageError('run needs the command after --');
  const options = { repo: { type: 'string' }, slots: { type: 'string' }, cache: { type: 'boolean' }, fresh: { type: 'boolean' }, log: { type: 'string' } };
  const { values } = parseArgs({ args: args.slice(0, split), options, strict: true, allowPositionals: false });
  const slots = values.slots === undefined ? undefined : Number(values.slots);
  if (slots !== undefined && !isSlotCount(slots)) throw new UsageError(`--slots must be a whole number from 1 to ${MAX_SLOTS}`);
  const repo = resolve(values.repo ?? '.');
  if (!statSync(repo, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--repo ${repo} is not a folder`);
  return { repo, slots, cache: values.cache === true, fresh: values.fresh === true, log: values.log, command: args.slice(split + 1) };
}

/** The repo's tree sha when its worktree is clean (no change, no untracked file), else null; null outside a repository too. */
function cleanTree(repo) {
  const status = runGit(repo, ['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0 || status.stdout !== '') return null;
  const tree = runGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']);
  return tree.status === 0 ? tree.stdout.trim() : null;
}

/** The folder the command runs in, relative to the repo's top (`pkgA/`, or '' at the top), so two worktrees share a key. */
const folderInRepo = (repo) => runGit(repo, ['rev-parse', '--show-prefix']).stdout.trim();

/** The last TAIL_BYTES of the log as lines (the first, likely cut, line dropped when the log is longer). */
function logTail(logPath) {
  const fd = openSync(logPath, 'r');
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return size > length ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

// Once the command has exited its pid may belong to another process, so it is never signalled then.
const isRunning = (child) => child !== null && child.exitCode === null && child.signalCode === null;

/**
 * Starts the command with stdout and stderr into the log, in its own process group (detached) so one kill reaches every test
 * process it starts (Windows: taskkill /T instead).
 * @returns {{ child: import('node:child_process').ChildProcess, exited: Promise<number> }} exited resolves to the exit code
 *   (128 + signal number after a signal; EXIT_CANNOT_START when the command cannot be started)
 */
function startLogged(command, repo, logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'w');
  const child = spawn(command[0], command.slice(1), { cwd: repo, stdio: ['ignore', logFd, logFd], detached: process.platform !== 'win32' });
  closeSync(logFd);
  const exited = new Promise((resolveExit) => {
    child.once('error', (error) => {
      console.error(`suite: cannot start ${command[0]}: ${error.message}`);
      resolveExit(EXIT_CANNOT_START);
    });
    child.once('exit', (code, signal) => resolveExit(code ?? 128 + constants.signals[signal]));
  });
  return { child, exited };
}

/**
 * SIGINT, SIGTERM and SIGHUP end the running command's group (SIGTERM, then SIGKILL after a grace), then exit with 128 + the
 * signal number; a second one during the grace sends SIGKILL to the group and exits at once. Any other exit sends the group
 * EXIT_SIGNAL. queue.mjs frees the slot and the ticket at exit.
 * @param {{child: import('node:child_process').ChildProcess | null, stopping: boolean}} current the running command, if any;
 *   `stopping` is set once a stop signal came, so runCommand neither reports nor caches the run it ends.
 */
function stopChildOnExit(current) {
  for (const signal of STOP_SIGNALS) process.on(signal, () => (current.stopping ? killAndExit(current, signal) : void stopAndExit(current, signal)));
  process.once('exit', () => isRunning(current.child) && signalProcessTree(current.child, EXIT_SIGNAL));
}

/** Ends the running command's group, if any, then exits with 128 + the number of `signal`. Never rejects. */
async function stopAndExit(current, signal) {
  current.stopping = true;
  try {
    if (isRunning(current.child)) await endProcessTree(current.child);
  } catch (error) {
    console.error(`suite: could not end the command's processes: ${error.message}`);
  }
  current.child = null; // ended: the exit handler must not signal its pid again
  process.exit(128 + constants.signals[signal]);
}

/** A second stop during the grace: SIGKILL to the running command's group, if any, then exit with 128 + the number of `signal`. */
function killAndExit(current, signal) {
  // Not isRunning: the leader may have exited on the SIGTERM while the rest of its group ignores it, and the group id stays
  // its pid while any member lives. stopAndExit sets child to null once the group is gone.
  if (current.child?.pid !== undefined) signalProcessTree(current.child, 'SIGKILL');
  current.child = null; // killed: the exit handler must not signal its pid again
  process.exit(128 + constants.signals[signal]);
}

/** Prints the verdict, the runner's summary lines, on failure the last lines, and the log path. */
function report(exitCode, commandText, logPath) {
  const tail = logTail(logPath);
  console.log(exitCode === 0 ? `PASS ${commandText}` : `FAIL (exit ${exitCode}) ${commandText}`);
  for (const line of tail.filter((entry) => SUMMARY_LINE.test(entry))) console.log(line);
  if (exitCode !== 0) {
    console.log(`last ${FAILURE_TAIL_LINES} lines of the log:`);
    for (const line of tail.slice(-FAILURE_TAIL_LINES)) console.log(line);
  }
  console.log(`log: ${logPath}`);
}

/** `suite run`: with --cache a hit prints `cached PASS`; otherwise waits for a slot, runs, reports and (with --cache) records a pass. */
async function runCommand(args) {
  const options = readRunArgs(args);
  const stateDir = stateFolder();
  const config = readConfig(stateDir);
  const commandText = options.command.join(' ');
  const treeBefore = options.cache && config.cache ? cleanTree(options.repo) : null;
  const folder = treeBefore && folderInRepo(options.repo);
  const key = treeBefore && cacheKey({ tree: treeBefore, folder, command: options.command, nodeVersion: process.version, platform: process.platform });
  const hit = key && !options.fresh ? lookup(stateDir, key) : null;
  if (hit !== null) {
    console.log(`cached PASS ${treeBefore.slice(0, TREE_PREFIX)} ${hit.at} ${commandText}`);
    console.log(`log: ${hit.log}`);
    return EXIT_OK;
  }
  const current = { child: null, stopping: false };
  stopChildOnExit(current); // from here, also while waiting for a slot
  const slot = await acquireSlot({ stateDir, slots: options.slots ?? config.slots, label: { repo: options.repo, command: commandText } });
  const logsDir = join(stateDir, 'logs');
  removeOlderThan(logsDir, CACHE_KEEP_MS);
  const logPath = resolve(options.log ?? join(logsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`));
  const run = startLogged(options.command, options.repo, logPath);
  current.child = run.child;
  const exitCode = await run.exited;
  slot.release();
  // A stop signal ended the command: stopAndExit exits with 128 + its number once the group is gone; nothing is reported or cached.
  if (current.stopping) return exitCode;
  report(exitCode, commandText, logPath);
  // the run itself may have changed or added files, or a commit may have landed meanwhile: then the pass belongs to no tree
  if (exitCode === 0 && key && cleanTree(options.repo) === treeBefore) {
    recordPass(stateDir, key, { at: new Date().toISOString(), tree: treeBefore, command: options.command, repo: options.repo, log: logPath });
  }
  return exitCode;
}

/** `suite related`: prints the related test files, `full` (with the reason on stderr) or `none`. */
async function relatedCommand(args) {
  const options = { repo: { type: 'string' }, base: { type: 'string' }, tip: { type: 'string' } };
  const { values } = parseArgs({ args, options, strict: true, allowPositionals: false });
  if (values.base === undefined) throw new UsageError('related needs --base <ref>');
  const repo = resolve(values.repo ?? '.');
  let changedFiles;
  let top;
  try {
    const range = await rangeScope(repo, values.base, values.tip ?? null);
    // with --tip the worktree's own changes count too: a selection too wide costs time, one too narrow misses a failure
    const worktree = values.tip === undefined ? [] : (await rangeScope(repo, 'HEAD', null)).files;
    changedFiles = [...new Set([...range.files, ...worktree])];
    top = range.top;
  } catch (error) {
    throw new UsageError(error.message);
  }
  const related = relatedTests({ repo: top, changedFiles });
  if (related.kind === 'files') for (const file of related.files) console.log(file);
  else console.log(related.kind);
  if (related.kind === 'full') console.error(`suite related: full: ${related.why}`);
  return EXIT_OK;
}

/** `suite status`: the slot count, each held slot and each waiter. */
function statusCommand(args) {
  if (args.length > 0) throw new UsageError('status takes no arguments');
  const stateDir = stateFolder();
  const { holders, waiters } = queueState(stateDir);
  // a planted or foreign record ({}, [], a pid of "abc") has no pid to show: say so plainly instead of `pid undefined`
  const describe = (entry, kind) =>
    Number.isInteger(entry?.pid) && entry.pid > 0
      ? `pid ${entry.pid} since ${entry.startedAt ?? entry.since} repo ${entry.repo} command ${entry.command}`
      : `invalid ${kind} (no valid pid)`;
  console.log(`slots: ${readConfig(stateDir).slots} (state ${stateDir})`);
  if (holders.length === 0) console.log('no suite running');
  for (const { slot, holder, stale } of holders) {
    console.log(`slot ${slot}: ${holder === null ? 'being taken' : describe(holder, 'holder')}${stale ? ' (stale: the next waiter removes it)' : ''}`);
  }
  for (const waiter of waiters) console.log(`waiting: ${describe(waiter, 'ticket')}`);
  return EXIT_OK;
}

const COMMANDS = { run: runCommand, related: relatedCommand, status: statusCommand };

async function main([name, ...args]) {
  try {
    if (!Object.hasOwn(COMMANDS, name ?? '')) throw new UsageError(name === undefined ? 'no command given' : `unknown command ${name}`);
    return await COMMANDS[name](args);
  } catch (error) {
    if (!(error instanceof UsageError) && !error?.code?.startsWith?.('ERR_PARSE_ARGS_')) throw error;
    console.error(`suite: ${error.message}\n${USAGE}`);
    return EXIT_USAGE;
  }
}

process.exitCode = await main(process.argv.slice(2));
