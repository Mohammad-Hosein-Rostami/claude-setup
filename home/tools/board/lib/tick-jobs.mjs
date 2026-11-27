// Purpose: the jobs `board tick` keeps per repository (plan-core-best, cb-plans-1): every pieces.json the boss passed with
//   `--plan` is remembered, so a later tick reads them all without one, and a job leaves the list when it is done or forgotten.
//   Also the per-job facts across plans: the ledger lands that belong to a plan, and the branches two plans both name.
// Exports: repoStateDir(repoDir, env), withStateLock(lock, busy, work), jobsFile(repoDir, env), readJobs(repoDir, env),
//   rememberPlans(repoDir, planPaths, env), forgetPlan(repoDir, planPath, env), landsOfPlan(repo, plan, entries), clashesOf(plans).
// File: <HOME>/.claude/state/board/repos/<repo-key>.json = { "plans": ["<abs pieces.json>", ...] }, <repo-key> the land ledger's
//   (land/ledger.mjs repoKey), so every worktree of one repository shares one list and another repository never sees it. The job's
//   own state (tess marks, tick-plan.mjs) lives in the folder <HOME>/.claude/state/board/repos/<repo-key>/.
// Invariants: a change of the list is a read, a change and a write under `<repo-key>.lock` beside it (O_EXCL,
//   disk-free/lib/lock-file.mjs), so two ticks that add plans at once keep both; the write is a temp file and a rename
//   (session-store.mjs, 0600, no link followed, never swept), so a crash leaves the old list. A list that cannot be read is a
//   problem the caller prints, never a crash and never overwritten.
import { join } from 'node:path';
import { releaseLock, takeLock } from '../../disk-free/lib/lock-file.mjs';
import { UsageError, runGit } from '../../git-tidy/lib/git.mjs';
import { repoKey } from '../../land/ledger.mjs';
import { privateFolder, readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { boardDir } from './refresh.mjs';
import { pieceBranch } from './tick-features.mjs';

const MAX_JOBS_BYTES = 64 * 1024; // some 500 plan paths: a bigger file was not written by this tool
const STATE_LOCK_STALE_MS = 10_000; // a turn is one small read and one write: a lock this old was left by a killed call
const STATE_LOCK_WAIT_MS = 2_000; // the longest a call waits for its turn
const STATE_LOCK_RETRY_MS = 50;
const PAUSE = new Int32Array(new SharedArrayBuffer(4)); // Atomics.wait on it is a synchronous sleep
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;

const reposDir = (env) => join(boardDir(env), 'repos');
const isPlansList = (value) => value !== null && typeof value === 'object' && Array.isArray(value.plans)
  && value.plans.every((path) => typeof path === 'string' && ABSOLUTE_PATH.test(path));

/** The folder of one repository's job state (the tess marks): <HOME>/.claude/state/board/repos/<repo-key>. */
export const repoStateDir = (repoDir, env = process.env) => join(reposDir(env), repoKey(repoDir));

/** The remembered plans file of the repository that holds `repoDir`: <HOME>/.claude/state/board/repos/<repo-key>.json. */
export const jobsFile = (repoDir, env = process.env) => join(reposDir(env), `${repoKey(repoDir)}.json`);

/**
 * Runs `work` while this call holds the lock file `lock`, waiting up to STATE_LOCK_WAIT_MS for its turn; a lock older than
 * STATE_LOCK_STALE_MS was left by a killed call and is broken.
 * @param {string} lock the lock file's path (its folder must exist)
 * @param {string} busy the message when another call held the lock the whole wait
 * @param {() => T} work the read-modify-write to run in turn
 * @returns {T} what `work` returns
 * @throws {UsageError} `busy`; anything `work` throws (the lock is released first)
 * @template T
 */
export function withStateLock(lock, busy, work) {
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  while (!takeLock(lock, Date.now(), STATE_LOCK_STALE_MS)) {
    if (Date.now() >= deadline) throw new UsageError(busy);
    Atomics.wait(PAUSE, 0, 0, STATE_LOCK_RETRY_MS);
  }
  try {
    return work();
  } finally {
    releaseLock(lock);
  }
}

/**
 * The plans the repository's ticks remember, in the order they were first passed.
 * @param {string} repoDir any folder of the repository
 * @param {object} [env] the environment (HOME), process.env by default
 * @returns {{ plans: string[], problem: string | null }} no plans and no problem before the first `--plan`; no plans and why when
 *   the file cannot be read (a link, too big, torn, not the format)
 */
export function readJobs(repoDir, env = process.env) {
  const file = jobsFile(repoDir, env);
  const text = readSessionFile(reposDir(env), repoKey(repoDir), MAX_JOBS_BYTES);
  if (text === null) return { plans: [], problem: null };
  const unreadable = (why) => ({ plans: [], problem: `${file} ${why}; delete it to start the list again` });
  if (text === undefined) return unreadable(`is not a plain file of yours, or over ${MAX_JOBS_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return unreadable(`is not JSON (${error.message})`);
  }
  return isPlansList(value) ? { plans: value.plans, problem: null } : unreadable('holds no "plans" list of absolute paths');
}

/** Applies `change` to the remembered list under its lock and writes the result when it differs; returns the new list. */
function changePlans(repoDir, env, change) {
  const dir = reposDir(env);
  const key = repoKey(repoDir);
  const notPlain = `cannot write the remembered plans ${jobsFile(repoDir, env)}: its folder or file is not a plain one of yours`;
  if (privateFolder(dir) === undefined) throw new UsageError(notPlain); // the lock file goes in it, so it must be there first
  return withStateLock(join(dir, `${key}.lock`), `another tick is writing ${jobsFile(repoDir, env)}; run it again`, () => {
    const { plans, problem } = readJobs(repoDir, env);
    if (problem !== null) throw new UsageError(problem);
    const next = change(plans);
    const isSame = next.length === plans.length && next.every((path, at) => path === plans[at]);
    if (!isSame && !writeSessionFile(dir, key, `${JSON.stringify({ plans: next }, null, 2)}\n`, { sweep: false })) throw new UsageError(notPlain);
    return next;
  });
}

/**
 * Adds plans to the repository's list (the union: a path already there keeps its place).
 * @param {string} repoDir any folder of the repository
 * @param {string[]} planPaths absolute pieces.json paths, already read and checked (tick-plan.mjs readPlan)
 * @param {object} [env] the environment (HOME)
 * @returns {string[]} the list after the union
 * @throws {UsageError} the list cannot be read (readJobs's problem) or written, or another tick held its lock the whole wait
 */
export function rememberPlans(repoDir, planPaths, env = process.env) {
  return changePlans(repoDir, env, (plans) => [...plans, ...planPaths.filter((path, at) => !plans.includes(path) && planPaths.indexOf(path) === at)]);
}

/**
 * Removes one plan from the repository's list (`tick --forget-plan`, or a job that is done).
 * @param {string} repoDir any folder of the repository
 * @param {string} planPath the absolute path as remembered
 * @param {object} [env] the environment (HOME)
 * @returns {boolean} whether the path was in the list
 * @throws {UsageError} as rememberPlans
 */
export function forgetPlan(repoDir, planPath, env = process.env) {
  let isRemoved = false;
  changePlans(repoDir, env, (plans) => {
    isRemoved = plans.includes(planPath);
    return plans.filter((path) => path !== planPath);
  });
  return isRemoved;
}

/**
 * The ledger lands of a plan's pieces: a land of one of its branches made after the plan's base. A land the base already holds
 * belongs to an older job that used the same branch name (an old `lane/docs-1` never counts for a new job's `docs-1`); a land
 * git cannot place (its commit is gone) counts, so a doubt reads as landed and not checked, never as waiting work.
 * @param {{ dir: string }} repo openRepo's result
 * @param {{ base: string, pieces: object[] }} plan readPlan's result
 * @param {{ branch: string, to: string }[]} entries the land ledger, oldest first
 * @returns {object[]} the plan's entries, in ledger order
 */
export function landsOfPlan(repo, plan, entries) {
  const branches = new Set(plan.pieces.map(pieceBranch));
  return entries.filter(({ branch, to }) => branches.has(branch) && runGit(repo.dir, ['merge-base', '--is-ancestor', to, plan.base]).status !== 0);
}

/**
 * The branches two or more plans name: neither piece may start, as both would build on one branch.
 * @param {{ job: string, pieces: object[] }[]} plans readPlan's results (one plan never names a branch twice: readPlan refuses it)
 * @returns {{ branch: string, owners: { job: string, piece: string }[] }[]} each clash with its pieces, in plan order
 */
export function clashesOf(plans) {
  const owners = new Map();
  for (const plan of plans) {
    for (const piece of plan.pieces) owners.set(pieceBranch(piece), [...(owners.get(pieceBranch(piece)) ?? []), { job: plan.job, piece: piece.id }]);
  }
  return [...owners].filter(([, list]) => list.length > 1).map(([branch, list]) => ({ branch, owners: list }));
}
