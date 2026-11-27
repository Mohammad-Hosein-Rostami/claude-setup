// Purpose: the `git-tidy lane` command: parse `claim | list | release | reclaim`, run lane-pool.mjs (and lane-prep.mjs after a claim),
//   print text lines or one JSON object, return the exit code.
// Exports: LANE_USAGE, runLaneCommand, claimPrepared (the claim `board start` makes too), laneExit (the exit code of a thrown error).
// Exit codes: claim 0 claimed and ready, 1 claimed but an install failed (the "lane not ready" lines; the folder is not handed out),
//   2 usage (bad sha, a new branch's --base not on the base, an existing branch claimed on another base, a branch that fails check-ref-format,
//   --snapshot with --branch, a branch checked out or being filled in another folder: named), 4 the pool lock stayed held by another
//   live claim, 14 a git command, the lane's base record or the clone fill failed (the folder is not handed out). A snapshot claim
//   (--snapshot) has the same codes. list 0. release 0 detached, 3 refused (why; with --expect also when the folder's lock reason
//   is not the expected one). reclaim 0, 1 a removal failed.
//   Every command: 2 usage, 4 pool lock busy, 14 git failed.
// Invariants: --repo and --folder are absolute paths; only lane-pool.mjs writes; a job-made record that could not be written is one stderr
//   line (the folder is then not swept by the job-leftover sweep, the safe side).
import { fileURLToPath } from 'node:url';
import { UsageError } from './git.mjs';
import { claimLane, poolSlots, reclaimLanes, releaseLane } from './lane-pool.mjs';
import { installFolder, prepareLane } from './lane-prep.mjs';
import { POOL_EXCLUDE_LINE } from './pool-ignore.mjs';
import { PoolBusy } from './pool-lock.mjs';
import { openRepo } from './repo.mjs';
import { shellWord } from './shell-word.mjs';

export const LANE_USAGE = 'usage: git-tidy.mjs lane claim --repo <abs> --branch <name> [--base <40-hex sha>] [--json]\n'
  + '       git-tidy.mjs lane claim --repo <abs> --snapshot [--base <40-hex sha>] [--json]\n'
  + '       git-tidy.mjs lane list --repo <abs> [--json]\n'
  + '       git-tidy.mjs lane release --repo <abs> --folder <abs lane folder> [--expect <lock reason>] [--json]\n'
  + '       git-tidy.mjs lane reclaim --repo <abs> [--json]';
const EXIT = Object.freeze({ ok: 0, notReady: 1, failed: 1, usage: 2, refused: 3, busy: 4, git: 14 });
const NEEDS = Object.freeze({ claim: ['repo', 'branch'], list: ['repo'], release: ['repo', 'folder'], reclaim: ['repo'] });
// flags a command takes but does not need (claim: the base's tip by default; release: no lock reason check by default)
const OPTIONAL = Object.freeze({ claim: ['base'], release: ['expect'] });
const FLAGS = Object.freeze({ '--repo': 'repo', '--branch': 'branch', '--base': 'base', '--folder': 'folder', '--expect': 'expect' });
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;
const WRITTEN_RECORDS = new Set(['recorded', 'filled']);
const DONE_OUTCOMES = new Set(['installed', 'cloned']); // prepareLane outcomes that put node_modules in place now
const CLI = fileURLToPath(new URL('../git-tidy.mjs', import.meta.url));

function parseLaneArgs([command, ...rest]) {
  if (!Object.hasOwn(NEEDS, command ?? '')) throw new UsageError(LANE_USAGE);
  const options = { command, json: false, snapshot: false, repo: null, branch: null, base: null, folder: null, expect: null };
  for (let i = 0; i < rest.length; i++) {
    const name = FLAGS[rest[i]];
    if (rest[i] === '--json') options.json = true;
    else if (rest[i] === '--snapshot' && command === 'claim') options.snapshot = true;
    else if (name !== undefined && [...NEEDS[command], ...(OPTIONAL[command] ?? [])].includes(name)) {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new UsageError(`${rest[i]} needs a value. ${LANE_USAGE}`);
      options[name] = rest[++i];
    } else throw new UsageError(`unknown argument ${JSON.stringify(rest[i])} for lane ${command}. ${LANE_USAGE}`);
  }
  // a snapshot has no branch (claimLane refuses --snapshot with --branch)
  const missing = NEEDS[command].filter((name) => options[name] === null && !(options.snapshot && name === 'branch'));
  if (missing.length > 0) throw new UsageError(`lane ${command} needs ${missing.map((name) => `--${name}`).join(', ')}. ${LANE_USAGE}`);
  for (const name of ['repo', 'folder']) {
    if (options[name] !== null && !ABSOLUTE_PATH.test(options[name])) throw new UsageError(`--${name} must be an absolute path, got ${JSON.stringify(options[name])}`);
  }
  return options;
}

function warnRecord(record) {
  if (record !== undefined && !WRITTEN_RECORDS.has(record)) console.error(`git-tidy: job-made record not written (${record}): the job-leftover sweep will not remove this folder`);
}

/** The lane-new.sh style lines for a claimed folder whose install failed. */
function notReadyLines(repoDir, claimed, failed) {
  return [
    `lane not ready: ${failed.command} failed in ${failed.dir}: ${failed.why}`,
    `  worktree: ${claimed.folder} (${claimed.snapshot ? `snapshot, detached at ${claimed.base}` : `branch ${claimed.branch}, on ${claimed.baseBranch}`})`,
    `  to finish:  cd ${shellWord(installFolder(claimed.folder, failed.dir))} && ${failed.command}`,
    `  to release: node ${shellWord(CLI)} lane release --repo ${shellWord(repoDir)} --folder ${shellWord(claimed.folder)}`,
  ];
}

/** The `fill:` line: what the clone fill did, or why the folder was checked out instead. */
const fillLine = (fill) => (fill.mode === 'checkout' ? `fill: checkout (${fill.why})`
  : `fill: ${fill.mode} ${fill.seconds.toFixed(1)} s, ${fill.entries} entries, repaired ${fill.repaired}`);

/** An install for the `installed:` line; one whose node_modules came from the deps cache (lane-deps.mjs) says so. */
const installedText = (install) => `${install.command} in ${install.dir}${install.outcome === 'cloned' ? ' (from the deps cache)' : ''}`;

/** The stderr line for what the claim did to keep the pool out of `git status` (pool-ignore.mjs); none when git already ignored it. */
function reportPoolIgnore(repoDir, { outcome, path, why }) {
  if (outcome === 'added') console.error(`git-tidy: added ${POOL_EXCLUDE_LINE} to ${path} so lane folders stay out of git status`);
  if (outcome === 'failed') console.error(`git-tidy: lane folders show in git status of ${repoDir} (${why}): land refuses there until git ignores .claude/worktrees/`);
}

/**
 * The claim of `lane claim`: claimLane, its warnings on stderr, then prepareLane, so the folder has its deps warm. `board start`
 * claims with it too, so a started lane is the same as one claimed by hand.
 * @param {object} repo openRepo's result
 * @param {{ repo: string, branch: string | null, base: string | null, snapshot: boolean }} options the main checkout as given
 *   (for the printed commands) and claimLane's options
 * @returns {{ claimed: object, prep: object, notReady: string[] | null }} claimLane's and prepareLane's results, and the
 *   `lane not ready` lines when an install failed (the folder is then not handed out), else null
 * @throws what claimLane throws (laneExit gives its exit code)
 */
export function claimPrepared(repo, options) {
  const claimed = claimLane(repo, { branch: options.branch, base: options.base, snapshot: options.snapshot });
  reportPoolIgnore(options.repo, claimed.poolIgnore);
  warnRecord(claimed.record);
  claimed.fill.warnings.forEach((warning) => console.error(`git-tidy: fill warning: ${warning}`));
  const prep = prepareLane(claimed.folder);
  const failed = prep.installs.find((install) => install.outcome === 'failed');
  return { claimed, prep, notReady: failed === undefined ? null : notReadyLines(options.repo, claimed, failed) };
}

function runClaim(repo, options) {
  const { claimed, prep, notReady } = claimPrepared(repo, options);
  const installed = prep.installs.filter((install) => DONE_OUTCOMES.has(install.outcome)).map(installedText);
  if (options.json) console.log(JSON.stringify({ ...claimed, ready: prep.ready, installs: prep.installs }, null, 2));
  if (notReady !== null) {
    console.error(notReady.join('\n'));
    return EXIT.notReady;
  }
  if (!options.json) console.log([`lane: ${claimed.folder}`, `kept: ${claimed.kept.length > 0 ? claimed.kept.join(', ') : 'none'}`, `installed: ${installed.length > 0 ? installed.join(', ') : 'none'}`, fillLine(claimed.fill), ...(claimed.snapshot ? ['snapshot: true'] : [])].join('\n'));
  return EXIT.ok;
}

function runList(repo, options) {
  const slots = poolSlots(repo);
  if (options.json) console.log(JSON.stringify({ slots }, null, 2));
  else console.log(slots.length === 0 ? 'no lane folders' : slots.map(({ slot, state, why }) => `${slot} ${state} ${why}`).join('\n'));
  return EXIT.ok;
}

function runRelease(repo, options) {
  const result = releaseLane(repo, options.folder, options.expect);
  if (options.json) console.log(JSON.stringify({ folder: options.folder, ...result }, null, 2));
  else console.log(result.released ? [`released ${options.folder} (${result.why})`, ...(result.branch ? [result.branch] : [])].join('\n') : `refused: ${result.why}`);
  return result.released ? EXIT.ok : EXIT.refused;
}

function runReclaim(repo, options) {
  const items = reclaimLanes(repo);
  items.forEach((entry) => warnRecord(entry.record));
  const count = (action) => items.filter((entry) => entry.action === action).length;
  if (options.json) console.log(JSON.stringify({ items }, null, 2));
  else console.log([...items.map(({ action, slot, folder, why }) => `${action} ${slot} ${folder}: ${why}`), `lane reclaim: ${count('removed')} removed, ${count('kept')} kept, ${count('failed')} failed`].join('\n'));
  return count('failed') > 0 ? EXIT.failed : EXIT.ok;
}

const RUNNERS = Object.freeze({ claim: runClaim, list: runList, release: runRelease, reclaim: runReclaim });

/**
 * The exit code of an error a lane command threw (see the header).
 * @param {Error} error what the command threw
 * @returns {number} 2 usage, 4 the pool lock stayed busy, 14 any other failure (git, the base record, the fill)
 */
export function laneExit(error) {
  if (error instanceof UsageError) return EXIT.usage;
  return error instanceof PoolBusy ? EXIT.busy : EXIT.git;
}

/**
 * Runs `git-tidy lane <argv>` and prints its result.
 * @param {string[]} argv the arguments after `lane`
 * @returns {number} the exit code (see the header)
 */
export function runLaneCommand(argv) {
  try {
    const options = parseLaneArgs(argv);
    const repo = openRepo(options.repo, null);
    if (repo.baseMarkWarning !== null) console.error(`git-tidy lane: warning: ${repo.baseMarkWarning}`);
    return RUNNERS[options.command](repo, options);
  } catch (error) {
    console.error(`git-tidy lane: ${error.message}`);
    return laneExit(error);
  }
}
