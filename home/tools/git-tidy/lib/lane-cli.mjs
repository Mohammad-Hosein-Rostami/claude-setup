// Purpose: the `git-tidy lane` command: parse `claim | list | release | reclaim`, run lane-pool.mjs (and lane-prep.mjs after a claim),
//   print text lines or one JSON object, return the exit code.
// Exports: LANE_USAGE, runLaneCommand.
// Exit codes: claim 0 claimed and ready, 1 claimed but an install failed (the "lane not ready" lines; the folder is not handed out),
//   2 usage (bad sha, a branch that fails check-ref-format, --snapshot with --branch, a branch checked out or being filled in another
//   folder: named), 4 the pool lock stayed held by another live claim, 14 a git command or the clone fill failed (the folder is not
//   handed out). A snapshot claim (--snapshot) has the same codes. list 0. release 0 detached, 3 refused (why). reclaim 0, 1 a
//   removal failed.
//   Every command: 2 usage, 4 pool lock busy, 14 git failed.
// Invariants: --repo and --folder are absolute paths; only lane-pool.mjs writes; a job-made record that could not be written is one stderr
//   line (the folder is then not swept by the job-leftover sweep, the safe side).
import { fileURLToPath } from 'node:url';
import { UsageError } from './git.mjs';
import { claimLane, poolSlots, reclaimLanes, releaseLane } from './lane-pool.mjs';
import { installFolder, prepareLane } from './lane-prep.mjs';
import { PoolBusy } from './pool-lock.mjs';
import { openRepo } from './repo.mjs';

export const LANE_USAGE = 'usage: git-tidy.mjs lane claim --repo <abs> --branch <name> --base <40-hex sha> [--json]\n'
  + '       git-tidy.mjs lane claim --repo <abs> --snapshot --base <40-hex sha> [--json]\n'
  + '       git-tidy.mjs lane list --repo <abs> [--json]\n'
  + '       git-tidy.mjs lane release --repo <abs> --folder <abs lane folder> [--json]\n'
  + '       git-tidy.mjs lane reclaim --repo <abs> [--json]';
const EXIT = Object.freeze({ ok: 0, notReady: 1, failed: 1, usage: 2, refused: 3, busy: 4, git: 14 });
const NEEDS = Object.freeze({ claim: ['repo', 'branch', 'base'], list: ['repo'], release: ['repo', 'folder'], reclaim: ['repo'] });
const FLAGS = Object.freeze({ '--repo': 'repo', '--branch': 'branch', '--base': 'base', '--folder': 'folder' });
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;
const WRITTEN_RECORDS = new Set(['recorded', 'filled']);
const DONE_OUTCOMES = new Set(['installed', 'cloned']); // prepareLane outcomes that put node_modules in place now
const CLI = fileURLToPath(new URL('../git-tidy.mjs', import.meta.url));

function parseLaneArgs([command, ...rest]) {
  if (!Object.hasOwn(NEEDS, command ?? '')) throw new UsageError(LANE_USAGE);
  const options = { command, json: false, snapshot: false, repo: null, branch: null, base: null, folder: null };
  for (let i = 0; i < rest.length; i++) {
    const name = FLAGS[rest[i]];
    if (rest[i] === '--json') options.json = true;
    else if (rest[i] === '--snapshot' && command === 'claim') options.snapshot = true;
    else if (name !== undefined && NEEDS[command].includes(name)) {
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

/** A word a POSIX shell reads back as itself, for the lines a person copies. */
const shellWord = (text) => (/^[\w./:@%+=,-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

function warnRecord(record) {
  if (record !== undefined && !WRITTEN_RECORDS.has(record)) console.error(`git-tidy: job-made record not written (${record}): the job-leftover sweep will not remove this folder`);
}

/** The lane-new.sh style lines for a claimed folder whose install failed. */
function notReadyLines(repoDir, claimed, failed) {
  return [
    `lane not ready: ${failed.command} failed in ${failed.dir}: ${failed.why}`,
    `  worktree: ${claimed.folder} (${claimed.snapshot ? `snapshot, detached at ${claimed.base}` : `branch ${claimed.branch}`})`,
    `  to finish:  cd ${shellWord(installFolder(claimed.folder, failed.dir))} && ${failed.command}`,
    `  to release: node ${shellWord(CLI)} lane release --repo ${shellWord(repoDir)} --folder ${shellWord(claimed.folder)}`,
  ];
}

/** The `fill:` line: what the clone fill did, or why the folder was checked out instead. */
const fillLine = (fill) => (fill.mode === 'checkout' ? `fill: checkout (${fill.why})`
  : `fill: ${fill.mode} ${fill.seconds.toFixed(1)} s, ${fill.entries} entries, repaired ${fill.repaired}`);

/** An install for the `installed:` line; one whose node_modules came from the deps cache (lane-deps.mjs) says so. */
const installedText = (install) => `${install.command} in ${install.dir}${install.outcome === 'cloned' ? ' (from the deps cache)' : ''}`;

function runClaim(repo, options) {
  const claimed = claimLane(repo, { branch: options.branch, base: options.base, snapshot: options.snapshot });
  warnRecord(claimed.record);
  claimed.fill.warnings.forEach((warning) => console.error(`git-tidy: fill warning: ${warning}`));
  const prep = prepareLane(claimed.folder);
  const failed = prep.installs.find((install) => install.outcome === 'failed');
  const installed = prep.installs.filter((install) => DONE_OUTCOMES.has(install.outcome)).map(installedText);
  if (options.json) console.log(JSON.stringify({ ...claimed, ready: prep.ready, installs: prep.installs }, null, 2));
  if (failed !== undefined) {
    console.error(notReadyLines(options.repo, claimed, failed).join('\n'));
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
  const result = releaseLane(repo, options.folder);
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
 * Runs `git-tidy lane <argv>` and prints its result.
 * @param {string[]} argv the arguments after `lane`
 * @returns {number} the exit code (see the header)
 */
export function runLaneCommand(argv) {
  try {
    const options = parseLaneArgs(argv);
    return RUNNERS[options.command](openRepo(options.repo, null), options);
  } catch (error) {
    console.error(`git-tidy lane: ${error.message}`);
    if (error instanceof UsageError) return EXIT.usage;
    return error instanceof PoolBusy ? EXIT.busy : EXIT.git;
  }
}
