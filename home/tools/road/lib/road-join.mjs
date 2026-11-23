// Purpose: `road.mjs join`: the scope judging of one built lane. It lists the files of the lane's range that lie outside the lane and counts
//   its UI files (ui-proof's own function, never its CLI: a crashed CLI exits 1, which reads as "some"). A model reads no number.
// Exports: joinLane(road, roadSha256, flags) -> { code, out }.
// Exit: 0 joined clean, 3 joined with findings, 1 refused (hash, lane, a running git operation, a HEAD that moved, a --base that is not the
//   merge-base, read at join time in the road's repo, of the tip and the road's base branch: the join judges the range land-lane lands), 2 usage.
// Output lines: `joined <sha>`, `finding <id>: <text>`, `ui-files: <n>` and one `ui-file <path>` line per UI file. A line is never made of
//   text a repo printed: names with control characters are quoted.
// Invariants: one join at a time per lane worktree (a `road-join.lock` folder in its git dir with the pid; a dead holder's lock is removed);
//   paths from git are read with -z (pathsOverlap compares them after `\` becomes `/`); git runs without GIT_* variables and with literal pathspecs. A
//   worktree that moves under the join (a running cherry-pick, uncommitted changes at the start, a HEAD that changed) is refused.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { changedUiFiles } from '../../ui-proof/lib/ui-files.mjs';
import { LANE_NAME, pathsOverlap } from './road-file.mjs';

const EXIT = { clean: 0, refused: 1, usage: 2, findings: 3 };
const GIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 << 20;
const TIMED_OUT_EXIT = -1; // a run that timed out, was killed or did not start has no exit status
const FLAGS = { '--road-sha256': ['sha256', /^[0-9a-f]{64}$/], '--lane': ['lane', LANE_NAME], '--worktree': ['worktree', /^(?:\/|[A-Za-z]:[\\/])[^\0\r\n]*$/],
  '--base': ['base', /^[0-9a-f]{40}$/] };
const SWITCHES = { '--json': 'json' };
const REQUIRED = ['sha256', 'lane', 'worktree', 'base'];
const RUNNING_OPERATIONS = { CHERRY_PICK_HEAD: 'a cherry-pick', MERGE_HEAD: 'a merge', REVERT_HEAD: 'a revert', 'rebase-merge': 'a rebase', 'rebase-apply': 'a rebase' };
const LOCK_FOLDER = 'road-join.lock'; // in the worktree's own git dir; holds a file `pid`
const USAGE = 'usage: road.mjs join <road.json> --road-sha256 <hex> --lane <name> --worktree <abs> --base <40-hex> [--json]';

class Refused extends Error {}
class Usage extends Error {}

const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const printable = (name) => (/[\x00-\x1f\x7f]/.test(name) ? JSON.stringify(name) : name);
const firstLine = (text) => String(text).trim().split('\n')[0];

function exec(command, args, cwd, timeout) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: MAX_OUTPUT_BYTES, env: environment() });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
  return { exit: result.error ? TIMED_OUT_EXIT : (result.status ?? TIMED_OUT_EXIT), stdout: result.stdout ?? '', out: text };
}

const git = (cwd, args) => exec('git', ['--literal-pathspecs', ...args], cwd, GIT_TIMEOUT_MS);

/** Stdout of a git call that must succeed. @throws {Refused} naming the call */
function gitOut(cwd, args) {
  const result = git(cwd, args);
  if (result.exit !== 0) throw new Refused(`git ${args[0]} failed in ${cwd}: ${firstLine(result.out)}`);
  return result.stdout;
}

const gitNames = (cwd, args) => gitOut(cwd, args).split('\0').filter(Boolean);
const headOf = (cwd) => gitOut(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();

function parseFlags(rest) {
  const options = { json: false };
  for (let at = 0; at < rest.length; at += 1) {
    if (Object.hasOwn(SWITCHES, rest[at])) options[SWITCHES[rest[at]]] = true;
    else if (Object.hasOwn(FLAGS, rest[at])) {
      const [key, pattern] = FLAGS[rest[at]];
      const value = rest[(at += 1)];
      if (value === undefined || !pattern.test(value)) throw new Usage(`${rest[at - 1]} needs a valid value. ${USAGE}`);
      options[key] = value;
    } else throw new Usage(`unknown argument ${printable(rest[at])}. ${USAGE}`);
  }
  for (const key of REQUIRED) if (options[key] === undefined) throw new Usage(`missing --${key === 'sha256' ? 'road-sha256' : key}. ${USAGE}`);
  return options;
}

/** The lane and its step, after the hash check. @throws {Refused} */
function findLane(road, roadSha256, options) {
  if (roadSha256 !== options.sha256) throw new Refused(`the road file's sha256 is ${roadSha256}, not --road-sha256 ${options.sha256}`);
  const found = road.steps.flatMap((step) => step.lanes.map((lane) => ({ lane, step }))).find((entry) => entry.lane.name === options.lane);
  if (found === undefined) throw new Refused(`lane ${options.lane} is not in the road`);
  return found;
}

/** Refuses a worktree another join or a person is working in: a running git operation or uncommitted changes to tracked files. */
function assertIdle(worktree) {
  for (const [marker, name] of Object.entries(RUNNING_OPERATIONS)) {
    if (existsSync(resolve(worktree, gitOut(worktree, ['rev-parse', '--git-path', marker]).trim()))) throw new Refused(`${name} is running in ${worktree}: another join or a person is working there`);
  }
  if (gitOut(worktree, ['status', '--porcelain', '--untracked-files=no']).trim() !== '') throw new Refused(`${worktree} has uncommitted changes to tracked files: commit them first`);
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const LOCK_START_GRACE_MS = 10_000; // a lock folder with no pid file yet is a holder that is starting; older than this, one that was killed first

const pidOf = (lock) => {
  try {
    return Number(readFileSync(join(lock, 'pid'), 'utf8').trim());
  } catch {
    return NaN; // no pid file (yet)
  }
};
const lockHolder = (lock) => (Number.isInteger(pidOf(lock)) ? `pid ${pidOf(lock)}` : 'starting');
function lockIsStale(lock) {
  if (Number.isInteger(pidOf(lock))) return !isAlive(pidOf(lock));
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_START_GRACE_MS;
  } catch {
    return true; // the lock went away between the two calls: the retry takes it
  }
}

/**
 * One join at a time per lane worktree: an atomic `mkdir` of `<git dir>/road-join.lock` holding the pid. A lock of a process that is gone
 * (a killed join) is removed once; a live holder refuses this join at once (the existing session lock waits 1 s and steals after 5 s, which
 * fits a hook's turn, not a join). @returns {() => void} the release @throws {Refused}
 */
function takeLock(worktree) {
  const lock = resolve(worktree, gitOut(worktree, ['rev-parse', '--git-path', LOCK_FOLDER]).trim());
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt > 0 || !lockIsStale(lock)) throw new Refused(`another join runs in ${worktree} (${lockHolder(lock)}): run one join at a time`);
      rmSync(lock, { recursive: true, force: true });
    }
  }
  writeFileSync(join(lock, 'pid'), String(process.pid));
  return () => rmSync(lock, { recursive: true, force: true });
}

function assertHead(worktree, expected) {
  if (headOf(worktree) !== expected) throw new Refused(`HEAD of ${worktree} moved during the join (another join or a person is working there)`);
}

/**
 * The tip of the lane worktree. --base must be the merge-base of that tip and the road's base branch in the road's repo, read now: a base
 * past the fork point would hide lane commits from the join that land-lane then lands, and after a rebase onto the base branch the
 * merge-base moves to where it was rebased.
 */
function readTip(road, options) {
  assertIdle(options.worktree);
  const tip = headOf(options.worktree);
  if (git(options.worktree, ['merge-base', '--is-ancestor', options.base, tip]).exit !== 0) throw new Refused(`--base ${options.base} is not an ancestor of the lane tip ${tip}`);
  const forkPoint = gitOut(road.repo, ['merge-base', tip, `refs/heads/${road.base}`]).trim();
  if (forkPoint !== options.base) {
    throw new Refused(`--base ${options.base} is not where the lane tip ${tip} leaves ${road.base}: their merge-base is now ${forkPoint} (it moves after a rebase onto ${road.base}); join with --base ${forkPoint}`);
  }
  return tip;
}

const finding = (id, text) => ({ id, text });

/** One finding per file of the joined range outside the lane files and the step's appendOnly. */
function scopeFindings(ctx) {
  const allowed = [...ctx.lane.files, ...(ctx.step.appendOnly ?? [])];
  const changed = gitNames(ctx.options.worktree, ['diff', '--name-only', '-z', '--no-renames', `${ctx.options.base}...${ctx.joined}`]);
  return changed.filter((file) => !allowed.some((entry) => pathsOverlap(file, entry))).map((file, at) => finding(`scope-${at + 1}`, `${printable(file)} changed but is outside the lane's files`));
}

/** The UI files of the range, by the function `ui-proof changed` prints from (one definition): { files } or { problem } (a failure is a finding, never "none"). */
function uiFilesOf(ctx) {
  try {
    return { files: changedUiFiles(ctx.options.worktree, ctx.options.base, ctx.joined) };
  } catch (error) {
    return { problem: `the UI files of the range cannot be listed: ${firstLine(error.message)}` };
  }
}

/** The join itself, alone in its worktree. @returns {object} the verdict; @throws {Refused} */
function judge(ctx) {
  const release = takeLock(ctx.options.worktree);
  try {
    return judgeLocked(ctx);
  } finally {
    release();
  }
}

function judgeLocked(ctx) {
  ctx.joined = readTip(ctx.road, ctx.options);
  const ui = uiFilesOf(ctx);
  assertHead(ctx.options.worktree, ctx.joined);
  const findings = [...scopeFindings(ctx), ...(ui.problem ? [finding('ui-files', ui.problem)] : [])];
  return { joined: ctx.joined, findings, uiFiles: ui.files ?? null };
}

function render(result, json) {
  if (json) return JSON.stringify({ joined: result.joined, findings: result.findings, uiFiles: result.uiFiles?.length ?? null, uiFileList: result.uiFiles ?? [] });
  const findingLines = result.findings.map(({ id, text }) => `finding ${id}: ${text}`);
  const uiLine = `ui-files: ${result.uiFiles === null ? 'unknown' : result.uiFiles.length}`;
  return [`joined ${result.joined}`, ...findingLines, uiLine, ...(result.uiFiles ?? []).map((file) => `  ui-file ${printable(file)}`)].join('\n');
}

/**
 * Runs `road.mjs join` for a road that readRoad accepted.
 * @param {object} road the checked road
 * @param {string} roadSha256 the sha256 of the bytes readRoad parsed
 * @param {string[]} flags the arguments after the road path
 * @returns {{ code: number, out: string }}
 */
export function joinLane(road, roadSha256, flags) {
  let json = false;
  try {
    const options = parseFlags(flags);
    json = options.json;
    const { lane, step } = findLane(road, roadSha256, options);
    const result = judge({ road, options, lane, step });
    return { code: result.findings.length === 0 ? EXIT.clean : EXIT.findings, out: render(result, json) };
  } catch (error) {
    if (error instanceof Usage) return { code: EXIT.usage, out: `road: ${error.message}` };
    if (error instanceof Refused) return { code: EXIT.refused, out: json ? JSON.stringify({ refused: error.message }) : `refused: ${error.message}` };
    throw error;
  }
}
