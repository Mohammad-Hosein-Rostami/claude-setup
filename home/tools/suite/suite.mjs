#!/usr/bin/env node
// Purpose: run a test suite through one machine-wide queue with a pass cache, and pick the tests a change can affect, so parallel
//   lanes neither overload the machine nor run the same suite on the same tree twice.
// Usage:
//   node ~/.claude/tools/suite/suite.mjs run [--repo <dir>] [--slots <n>] [--fresh] [--log <file>] -- <command> [args...]
//   node ~/.claude/tools/suite/suite.mjs related [--repo <dir>] --base <ref> [--tip <ref>]
//   node ~/.claude/tools/suite/suite.mjs status
// Exports: none (a CLI). Exit codes: run: the command's exit (128 + signal number when a signal ended it; 0 on a cache hit);
//   related and status: 0; 2 for a usage error, a bad config file, a bad ref or a folder that is not a repository.
// Invariants:
// - The command runs as argv, never through a shell, in the repo folder, in its own process group; SIGINT, SIGTERM and exit kill
//   that group and free the slot.
// - A pass is cached only when the tree was clean before and after the run and did not change; a failure is never cached.
// - State lives in `$CLAUDE_CONFIG_DIR/state/suite/` (else `~/.claude/state/suite/`): one queue for every session on the machine.
//   It holds only locks, the cache and logs, so it can be deleted at any time.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, fstatSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runGit } from '../git-tidy/lib/git.mjs';
import { rangeScope } from '../risk/lib/range.mjs';
import { CACHE_KEEP_MS, cacheKey, lookup, recordPass, removeOlderThan } from './lib/cache.mjs';
import { acquireSlot, queueState } from './lib/queue.mjs';
import { relatedTests } from './lib/related.mjs';

const USAGE = [
  'usage: node ~/.claude/tools/suite/suite.mjs run [--repo <dir>] [--slots <n>] [--fresh] [--log <file>] -- <command> [args...]',
  '       node ~/.claude/tools/suite/suite.mjs related [--repo <dir>] --base <ref> [--tip <ref>]',
  '       node ~/.claude/tools/suite/suite.mjs status',
].join('\n');
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const DEFAULT_CONFIG = { slots: 2, cache: true }; // slots: measured, see README.md "How many suites at once"
const MAX_SLOTS = 64;
const EXIT_CANNOT_START = 127; // as a shell reports a command it cannot find
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
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
  const options = { repo: { type: 'string' }, slots: { type: 'string' }, fresh: { type: 'boolean' }, log: { type: 'string' } };
  const { values } = parseArgs({ args: args.slice(0, split), options, strict: true, allowPositionals: false });
  const slots = values.slots === undefined ? undefined : Number(values.slots);
  if (slots !== undefined && !isSlotCount(slots)) throw new UsageError(`--slots must be a whole number from 1 to ${MAX_SLOTS}`);
  return { repo: resolve(values.repo ?? '.'), slots, fresh: values.fresh === true, log: values.log, command: args.slice(split + 1) };
}

/** The repo's tree sha when its worktree is clean (no change, no untracked file), else null; null outside a repository too. */
function cleanTree(repo) {
  const status = runGit(repo, ['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0 || status.stdout !== '') return null;
  const tree = runGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']);
  return tree.status === 0 ? tree.stdout.trim() : null;
}

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

/** Kills the child's whole process group (on Windows its process tree); a group that is already gone is fine. */
function killGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    // ESRCH: the group is gone; EPERM: macOS says so for a group left with only exited (zombie) members
    if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
  }
}

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

/** SIGINT, SIGTERM and SIGHUP exit; at exit the running child's group is killed, and queue.mjs frees the slot and the ticket. */
function stopChildOnExit(current) {
  for (const signal of STOP_SIGNALS) process.once(signal, () => process.exit(128 + constants.signals[signal]));
  process.once('exit', () => current.child !== null && killGroup(current.child));
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

/** `suite run`: a cache hit prints `cached PASS`; otherwise waits for a slot, runs, reports and records a pass. */
async function runCommand(args) {
  const options = readRunArgs(args);
  const stateDir = stateFolder();
  const config = readConfig(stateDir);
  const commandText = options.command.join(' ');
  const treeBefore = config.cache ? cleanTree(options.repo) : null;
  const key = treeBefore && cacheKey({ tree: treeBefore, command: options.command, nodeVersion: process.version, platform: process.platform });
  const hit = key && !options.fresh ? lookup(stateDir, key) : null;
  if (hit !== null) {
    console.log(`cached PASS ${treeBefore.slice(0, TREE_PREFIX)} ${hit.at} ${commandText}`);
    console.log(`log: ${hit.log}`);
    return EXIT_OK;
  }
  const current = { child: null };
  stopChildOnExit(current); // from here, also while waiting for a slot
  const slot = await acquireSlot({ stateDir, slots: options.slots ?? config.slots, label: { repo: options.repo, command: commandText } });
  const logsDir = join(stateDir, 'logs');
  removeOlderThan(logsDir, CACHE_KEEP_MS);
  const logPath = resolve(options.log ?? join(logsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`));
  const run = startLogged(options.command, options.repo, logPath);
  current.child = run.child;
  const exitCode = await run.exited;
  slot.release();
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
  const describe = (entry) => `pid ${entry.pid} since ${entry.startedAt ?? entry.since} repo ${entry.repo} command ${entry.command}`;
  console.log(`slots: ${readConfig(stateDir).slots} (state ${stateDir})`);
  if (holders.length === 0) console.log('no suite running');
  for (const { slot, holder, stale } of holders) {
    console.log(`slot ${slot}: ${holder === null ? 'being taken' : describe(holder)}${stale ? ' (stale: the next waiter removes it)' : ''}`);
  }
  for (const waiter of waiters) console.log(`waiting: ${describe(waiter)}`);
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
