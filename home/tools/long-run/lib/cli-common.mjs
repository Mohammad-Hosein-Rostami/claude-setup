// Purpose: what the long-run commands share: their error kinds (one per exit code), opening a run by id, the folder claims of a
//   run, the real dependencies of a driver, and starting a driver detached or in this process.
// Exports: UsageError, Refusal, NotFound, openRun, isLiveRun, claimRunFolders, driverDeps, startDriver.
// Invariants: a detached driver gets this process's environment (its own child env is built per start) and writes its output to
//   `<run>/driver.log` (0600); folder claims of a run are all taken or none (a refusal releases what it took).
import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { PRIVATE_FILE_MODE } from '../../account/lib/private-fs.mjs';
import { units } from './job.mjs';
import { claimFolder, releaseFolder, runPaths } from './run-store.mjs';
import { drive } from './driver.mjs';
import { cliPath } from './os-schedule.mjs';
import { runState } from './view.mjs';

/** Wrong arguments: exit 2. */
export class UsageError extends Error {}
/** Refused or failed, with what to do: exit 1. */
export class Refusal extends Error {}
/** No such run or step: exit 3. */
export class NotFound extends Error {}

const SETTLED = new Set(['done', 'abandoned', 'stopped']);

/**
 * @param {string} root stateRoot().
 * @param {string | undefined} runId the id the owner gave.
 * @returns {Record<string, string>} runPaths() of an existing run.
 * @throws {UsageError} with no id; {NotFound} for an id that is not a run here.
 */
export function openRun(root, runId) {
  if (!runId) throw new UsageError('give a run id (long-run status lists them)');
  let paths;
  try {
    paths = runPaths(root, runId);
  } catch {
    throw new NotFound(`no run ${String(runId).slice(0, 60)} (long-run status lists them)`);
  }
  if (!existsSync(paths.job)) throw new NotFound(`no run ${runId} (long-run status lists them)`);
  return paths;
}

/** Whether run `runId` still counts as live for a folder claim (not done, abandoned or stopped). */
export const isLiveRun = (root) => (runId) => {
  const paths = runPaths(root, runId);
  return existsSync(paths.job) && !SETTLED.has(runState(paths));
};

/**
 * Claims every folder a run works in (one live run per folder); items of a worktree group work in lanes and need none.
 * @throws {RunBusy} naming the live run that holds a folder (what was claimed here is released first).
 */
export function claimRunFolders(paths, job) {
  const folders = [job.cwd, ...units(job).filter((unit) => !(unit.kind === 'item' && unit.group.worktree)).map((unit) => unit.cwd)];
  const claimed = [];
  try {
    for (const folder of folders) {
      claimFolder(paths.root, paths.runId, folder, isLiveRun(paths.root));
      claimed.push(folder);
    }
  } catch (error) {
    for (const folder of claimed) releaseFolder(paths.root, paths.runId, folder);
    throw error;
  }
}

/** The dependencies of a real driver. */
export function driverDeps(env) {
  return {
    env, platform: process.platform, now: () => new Date(), random: Math.random, keepAwake: true,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), exit: (code) => process.exit(code),
  };
}

/**
 * Starts the run's driver: detached (its output in driver.log) or, with `foreground`, here until it holds or ends.
 * @param {Record<string, string>} paths runPaths().
 * @param {{env: object, foreground: boolean}} options
 * @returns {Promise<string>} `started` (detached) or how the foreground driver ended.
 */
export async function startDriver(paths, { env, foreground }) {
  if (foreground) return drive(paths, driverDeps(env));
  const log = openSync(paths.driverLog, 'a', PRIVATE_FILE_MODE);
  const child = spawn(process.execPath, [cliPath(), 'drive', paths.runId], { detached: true, stdio: ['ignore', log, log], env, windowsHide: true });
  child.unref();
  return 'started';
}
