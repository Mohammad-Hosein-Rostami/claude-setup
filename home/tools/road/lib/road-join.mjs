// Purpose: `road.mjs join`: the contract judging of one built lane (plan.md C5), the work join.js gave to a runner and to a script. It
//   cherry-picks the test-writer's commits into the lane worktree (one pick per commit), refuses a lane whose own commits edited a locked file, lists files outside
//   the lane, counts UI files (ui-proof's own function, never its CLI: a crashed CLI exits 1, which reads as "some"), runs each checkpoint at the joined head and at the base, and prints the verdict. A model reads no number.
// Exports: joinLane(road, roadSha256, flags, { run, checkOn }) -> { code, out }.
// Exit: 0 joined clean, 3 joined with findings, 1 refused (hash, lane, base, a running git operation, contractTouched, tests do not apply, a
//   HEAD that moved), 2 usage.
// Output lines: `joined <sha>`, `finding <id>: <text>` (a failed run's last 20 lines follow, each indented), `ui-files: <n>`,
//   `checkpoint <id>: <kind> base <n> head <n> met|not met`, `vacuous <id>`, `keep-green: pass|fail`, `checkpoints: none | not checked (test
//   off)`, `waiver-at <sha>`. A line is never made of text a repo or a command printed: names with control characters are quoted and run
//   output is indented, so no file or checkpoint can write a `waiver-at` line.
// Invariants: one join at a time per lane worktree (a `road-join.lock` folder in its git dir with the pid; a dead holder's lock is removed);
//   checkpoint commands come only from the hash-checked road file and run as `sh -c` in a worktree, never with a path in them;
//   paths from git are read with -z and compared after `\` becomes `/`; git runs without GIT_* variables and with literal pathspecs. Each
//   base-side run has its own detached worktree under the temp folder, named `road-join-<pid>-...`, removed in `finally`; the next join
//   removes those of a process that is gone (a killed join), and leaves those of a live one. A worktree that moves under the join (a
//   running cherry-pick, uncommitted changes at the start, a HEAD that is not the one the join made) is refused.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isOn } from '../../../hooks/lib/checks-on.mjs';
import { changedUiFiles } from '../../ui-proof/lib/ui-files.mjs';
import { LANE_NAME, pathsOverlap } from './road-file.mjs';

const EXIT = { clean: 0, refused: 1, usage: 2, findings: 3 };
const GIT_TIMEOUT_MS = 60_000;
const CHECKPOINT_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 16 << 20;
const TAIL_LINES = 20;
const MAX_LINE_CHARS = 300;
const TIMED_OUT_EXIT = -1; // a run that timed out, was killed or did not start has no exit status
const FLAGS = { '--road-sha256': ['sha256', /^[0-9a-f]{64}$/], '--lane': ['lane', LANE_NAME], '--worktree': ['worktree', /^(?:\/|[A-Za-z]:[\\/])[^\0\r\n]*$/],
  '--base': ['base', /^[0-9a-f]{40}$/], '--tests': ['tests', /^(?:\/|[A-Za-z]:[\\/])[^\0\r\n]*$/], '--checks': ['checks', /^[a-z]+(?:,[a-z]+)*$/] };
const SWITCHES = { '--dispute': 'dispute', '--json': 'json' };
const REQUIRED = ['sha256', 'lane', 'worktree', 'base'];
const RUNNING_OPERATIONS = { CHERRY_PICK_HEAD: 'a cherry-pick', MERGE_HEAD: 'a merge', REVERT_HEAD: 'a revert', 'rebase-merge': 'a rebase', 'rebase-apply': 'a rebase' };
const STALE_FOLDER = /^road-join-(\d+)-/;
const LOCK_FOLDER = 'road-join.lock'; // in the worktree's own git dir; holds a file `pid`
const USAGE = 'usage: road.mjs join <road.json> --road-sha256 <hex> --lane <name> --worktree <abs> --base <40-hex> [--tests <abs>] [--dispute] [--checks <cat,...>] [--json]';

class Refused extends Error {}
class Usage extends Error {}

const slashed = (path) => path.replace(/\\/g, '/');
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
  const options = { dispute: false, json: false, checks: '' };
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

/** The tip of the lane worktree and of the test-writer worktree (null without --tests); both must be of one repository, the base an ancestor of the tip. */
function readTips(options) {
  assertIdle(options.worktree);
  const tip = headOf(options.worktree);
  if (git(options.worktree, ['merge-base', '--is-ancestor', options.base, tip]).exit !== 0) throw new Refused(`--base ${options.base} is not an ancestor of the lane tip ${tip}`);
  if (options.tests === undefined) return { tip, testsHead: null };
  const commonDir = (cwd) => realpathSync(resolve(cwd, gitOut(cwd, ['rev-parse', '--git-common-dir']).trim()));
  if (commonDir(options.tests) !== commonDir(options.worktree)) throw new Refused(`--tests ${options.tests} is a worktree of another repository`);
  return { tip, testsHead: headOf(options.tests) };
}

/** Files changed by the lane's own commits (`<base>..<tip>`, minus the test-writer commits it already holds), read from each commit. */
function ownFiles(options, tip, testsHead) {
  const heldTests = testsHead === null ? [] : gitOut(options.worktree, ['cherry', testsHead, tip]).split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim());
  const commits = gitOut(options.worktree, ['rev-list', '--reverse', `${options.base}..${tip}`]).split('\n').filter((sha) => sha !== '' && !heldTests.includes(sha));
  return commits.flatMap((sha) => gitNames(options.worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', '-m', sha]));
}

/**
 * Cherry-picks the `+` commits of `git cherry <tip> <tests HEAD>` into the lane, oldest first, one `git cherry-pick` per commit: a
 * multi-commit call keeps a sequencer folder that a second join's `--abort` would rewind under the first. HEAD must be the one the join
 * made before each pick. A failed pick runs `git cherry-pick --abort` only when it left a conflict (CHERRY_PICK_HEAD); picks made before
 * it stay (a re-join finds them and skips them).
 */
function applyTests(options, tip, testsHead) {
  const picks = gitOut(options.worktree, ['cherry', tip, testsHead]).split('\n').filter((line) => line.startsWith('+ ')).map((line) => line.slice(2).trim());
  let head = tip;
  for (const sha of picks) {
    assertHead(options.worktree, head);
    const result = git(options.worktree, ['cherry-pick', sha]);
    if (result.exit !== 0) {
      if (git(options.worktree, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']).exit === 0) git(options.worktree, ['cherry-pick', '--abort']);
      throw new Refused(`tests do not apply: ${firstLine(result.out)}`);
    }
    head = headOf(options.worktree);
  }
  return head;
}

const finding = (id, text, tail = []) => ({ id, text, tail });

function removeBaseWorktree(worktree, path) {
  git(worktree, ['worktree', 'remove', '--force', path]);
  rmSync(path, { recursive: true, force: true });
  git(worktree, ['worktree', 'prune']);
}

/** Removes the base-side worktrees of a join that was killed: `road-join-<pid>-*` under the temp folder whose process is gone. */
function removeStaleWorktrees(worktree) {
  git(worktree, ['worktree', 'prune']);
  const temp = slashed(realpathSync(tmpdir()));
  for (const line of gitOut(worktree, ['worktree', 'list', '--porcelain']).split('\n').filter((entry) => entry.startsWith('worktree '))) {
    const path = line.slice('worktree '.length);
    const owner = STALE_FOLDER.exec(basename(path));
    if (owner !== null && slashed(dirname(path)) === temp && !isAlive(Number(owner[1]))) removeBaseWorktree(worktree, path);
  }
}

function tailOf(text) {
  const rows = text.split(/\r?\n/);
  while (rows.length > 0 && rows.at(-1) === '') rows.pop();
  return rows.slice(-TAIL_LINES).map((row) => row.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, MAX_LINE_CHARS));
}

/** `sh -c <command>` in `cwd`; { exit, tail } (exit -1 for a timeout or a run that did not start). */
function shell(command, cwd) {
  const result = exec('sh', ['-c', command], cwd, CHECKPOINT_TIMEOUT_MS);
  return { exit: result.exit, tail: tailOf(result.out) };
}

/** Runs one checkpoint at the base: a detached worktree at `base` with the checkpoint's files taken from the joined sha; always removed. */
function runAtBase(ctx, checkpoint) {
  const dir = mkdtempSync(join(tmpdir(), `road-join-${process.pid}-`));
  try {
    const added = git(ctx.options.worktree, ['worktree', 'add', '--detach', '--quiet', dir, ctx.options.base]);
    if (added.exit !== 0) throw new Refused(`cannot make the base worktree: ${firstLine(added.out)}`);
    if (checkpoint.files.length > 0) {
      const taken = git(dir, ['checkout', ctx.joined, '--', ...checkpoint.files.map(slashed)]);
      if (taken.exit !== 0) throw new Refused(`checkpoint ${checkpoint.id} files cannot be taken from ${ctx.joined}: ${firstLine(taken.out)}`);
    }
    return shell(checkpoint.run, dir);
  } finally {
    removeBaseWorktree(ctx.options.worktree, dir);
  }
}

/** The findings and the printed line of one checkpoint, from its base and head exits. */
function judgeCheckpoint(checkpoint, base, head) {
  const { id, run, exit, kind } = checkpoint;
  const vacuous = kind === 'red-first' && base.exit === exit;
  const found = [];
  if (head.exit !== exit) found.push(finding(`ckpt-${id}-head`, `checkpoint ${id} (${run}) exits ${head.exit} at the joined head, not ${exit}`, head.tail));
  if (vacuous) found.push(finding(`vacuous-${id}`, `checkpoint ${id} (${run}) passes without the change (vacuous)`));
  else if (kind === 'keeps-working' && base.exit !== exit) found.push(finding(`ckpt-${id}-base`, `checkpoint ${id} (${run}) exits ${base.exit} before the change: a keeps-working checkpoint must pass there`, base.tail));
  const line = `checkpoint ${id}: ${kind} base ${base.exit} head ${head.exit} ${found.length === 0 ? 'met' : 'not met'}`;
  return { found, line, vacuous: vacuous ? id : null, result: { id, kind, baseExit: base.exit, headExit: head.exit, met: found.length === 0 } };
}

/** All checkpoint runs of the lane (and its keepGreen) when `test` is on. @returns {{ state: 'off'|'none'|'ran', lines: string[], results: object[], findings: object[], redFirst: boolean }} */
function runCheckpoints(ctx) {
  if (!ctx.checkOn('test')) return { state: 'off', lines: ['checkpoints: not checked (test off)'], results: [], findings: [], redFirst: false };
  const checkpoints = ctx.lane.checkpoints ?? [];
  const lines = checkpoints.length === 0 ? ['checkpoints: none'] : [];
  const findings = [];
  const results = [];
  for (const checkpoint of checkpoints) {
    const judged = judgeCheckpoint(checkpoint, runAtBase(ctx, checkpoint), shell(checkpoint.run, ctx.options.worktree));
    lines.push(judged.line, ...(judged.vacuous === null ? [] : [`vacuous ${judged.vacuous}`]));
    findings.push(...judged.found);
    results.push(judged.result);
  }
  if (ctx.lane.keepGreen !== undefined) {
    const green = shell(ctx.lane.keepGreen, ctx.options.worktree);
    lines.push(`keep-green: ${green.exit === 0 ? 'pass' : 'fail'}`);
    if (green.exit !== 0) findings.push(finding('keepgreen', `keepGreen (${ctx.lane.keepGreen}) exits ${green.exit} at the joined head`, green.tail));
  }
  return { state: checkpoints.length === 0 ? 'none' : 'ran', lines, results, findings, redFirst: checkpoints.some((checkpoint) => checkpoint.kind === 'red-first') };
}

/** One finding per file of the joined range outside the lane files, the step's appendOnly and the test-writer files. */
function scopeFindings(ctx, testFiles) {
  const allowed = [...ctx.lane.files, ...(ctx.step.appendOnly ?? []), ...testFiles];
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
  const { options } = ctx;
  removeStaleWorktrees(options.worktree);
  const { tip, testsHead } = readTips(options);
  const testFiles = testsHead === null ? [] : gitNames(options.worktree, ['diff', '--name-only', '-z', '--no-renames', `${options.base}...${testsHead}`]);
  const afterTests = testsHead === null ? tip : applyTests(options, tip, testsHead);
  ctx.joined = afterTests;
  const locked = [...(ctx.lane.checkpoints ?? []).flatMap((checkpoint) => checkpoint.files), ...testFiles];
  const touched = ownFiles(options, tip, testsHead).filter((file) => locked.some((entry) => pathsOverlap(file, entry)));
  if (touched.length > 0) throw new Refused(`contractTouched: ${[...new Set(touched)].map(printable).join(', ')} (locked: a checkpoint or test-writer file); nothing judged`);
  const ui = uiFilesOf(ctx);
  const checks = runCheckpoints(ctx);
  assertHead(options.worktree, ctx.joined);
  const findings = [...scopeFindings(ctx, testFiles), ...(ui.problem ? [finding('ui-files', ui.problem)] : []), ...checks.findings];
  const waived = testsHead !== null && checks.state === 'ran' && checks.redFirst && findings.length === 0 && !options.dispute;
  return { joined: ctx.joined, findings, uiFiles: ui.files ?? null, checkpointLines: checks.lines, checkpoints: checks.results, checkpointState: checks.state, waiverAt: waived ? ctx.joined : null };
}

function render(result, json) {
  if (json) return JSON.stringify({ joined: result.joined, findings: result.findings, uiFiles: result.uiFiles?.length ?? null, uiFileList: result.uiFiles ?? [], checkpointState: result.checkpointState, checkpoints: result.checkpoints, waiverAt: result.waiverAt });
  const findingLines = result.findings.flatMap(({ id, text, tail }) => [`finding ${id}: ${text}`, ...tail.map((row) => `    | ${row}`)]);
  const uiLine = `ui-files: ${result.uiFiles === null ? 'unknown' : result.uiFiles.length}`;
  return [`joined ${result.joined}`, ...findingLines, uiLine, ...(result.uiFiles ?? []).map((file) => `  ui-file ${printable(file)}`), ...result.checkpointLines,
    ...(result.waiverAt === null ? [] : [`waiver-at ${result.waiverAt}`])].join('\n');
}

/**
 * Runs `road.mjs join` for a road that readRoad accepted.
 * @param {object} road the checked road
 * @param {string} roadSha256 the sha256 of the bytes readRoad parsed
 * @param {string[]} flags the arguments after the road path
 * @param {{ checkOn?: (category: string) => boolean }} [deps] checkOn defaults to the owner's /check switch; `--checks` only adds to it
 * @returns {{ code: number, out: string }}
 */
export function joinLane(road, roadSha256, flags, { checkOn = isOn } = {}) {
  let json = false;
  try {
    const options = parseFlags(flags);
    json = options.json;
    const { lane, step } = findLane(road, roadSha256, options);
    const result = judge({ options, lane, step, checkOn: (category) => checkOn(category) || options.checks.split(',').includes(category) });
    return { code: result.findings.length === 0 ? EXIT.clean : EXIT.findings, out: render(result, json) };
  } catch (error) {
    if (error instanceof Usage) return { code: EXIT.usage, out: `road: ${error.message}` };
    if (error instanceof Refused) return { code: EXIT.refused, out: json ? JSON.stringify({ refused: error.message }) : `refused: ${error.message}` };
    throw error;
  }
}
