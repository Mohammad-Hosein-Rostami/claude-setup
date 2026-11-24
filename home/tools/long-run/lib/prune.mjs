// Purpose: `long-run prune [--older-than <days>]` (audit H14): the state of finished runs is removed after a while, since the
//   SQLite checkpointer never prunes and every run keeps its logs.
// Exports: PRUNE_DEFAULT_DAYS, pruneCommand.
// Invariants: only a done or abandoned run whose end is at least that many days old is pruned; a running, held, paused,
//   stopped or stale run never is; the run's driver lock is taken first, so a rerun that starts at the same time wins and the run
//   is skipped; its checkpoints are deleted through the saver (setup() first, langgraphjs #3232), then its folder.
import { rmSync } from 'node:fs';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { RunBusy, acquireLock, listRunIds, readJson, runPaths } from './run-store.mjs';
import { UsageError } from './cli-common.mjs';
import { runState } from './view.mjs';

/** Finished runs older than this many days are pruned when no `--older-than` is given. */
export const PRUNE_DEFAULT_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FINISHED = new Set(['done', 'abandoned']);

function olderThanDays(flags) {
  const value = flags['older-than'];
  if (value === undefined) return PRUNE_DEFAULT_DAYS;
  if (!/^\d+$/.test(String(value))) throw new UsageError('--older-than takes a whole number of days');
  return Number(value);
}

function pruneOne(paths, now) {
  acquireLock(paths, now);
  const saver = SqliteSaver.fromConnString(paths.checkpoints);
  try {
    saver.setup();
    saver.deleteThread(paths.runId);
  } finally {
    saver.db.close();
  }
  rmSync(paths.dir, { recursive: true, force: true });
}

/**
 * Removes the state of every finished run that ended at least `--older-than` days ago (default 30).
 * @param {{flags: object, root: string, write: (line: string) => void, now?: Date}} context
 * @returns {Promise<string[]>} the run ids pruned.
 * @throws {UsageError} for an `--older-than` that is not a whole number.
 */
export async function pruneCommand({ flags, root, write, now = new Date() }) {
  const days = olderThanDays(flags);
  const pruned = [];
  for (const runId of listRunIds(root)) {
    const paths = runPaths(root, runId);
    const age = now.getTime() - Date.parse(readJson(paths.driver)?.beatAt ?? ''); // the last beat is when the run ended
    if (!FINISHED.has(runState(paths, now)) || Number.isNaN(age) || age < days * MS_PER_DAY) continue;
    try {
      pruneOne(paths, now);
    } catch (error) {
      if (!(error instanceof RunBusy)) throw error;
      write(`${runId}: skipped, its driver runs again (${error.message})`);
      continue;
    }
    pruned.push(runId);
    write(`pruned ${runId}`);
  }
  if (pruned.length === 0) write(`no finished run older than ${days} day(s)`);
  return pruned;
}
