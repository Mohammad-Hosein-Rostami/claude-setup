// Copies a workflow run's journal into another session's run folder, so that session can resume the run.
// Exports: adoptRun({ record, into, from }, projectsRoot) -> { ok, message }.
// Why: the Workflow tool looks a run's journal up only under the CURRENT session's folder (<session>/subagents/workflows/<runId>/journal.jsonl),
// so `resumeFromRunId` in a fork, a new session or another account's config dir fails with "nothing to resume" (round 5 probe, Claude Code
// 2.1.326). With the journal copied there, the same call works: finished agents come back from the cache, the rest run again. This relies on
// the undocumented folder layout; re-check it after a Claude Code upgrade.
// Invariants: `into` must be <projectsRoot>/<project>/<session id> (so nothing is written outside the projects folder); only journal.jsonl is
// copied, as a private file (0600) in a 0700 folder; an existing journal in the target is never overwritten (that session already moved on);
// the source is read through lstat (a plain file, at most MAX_JOURNAL_BYTES); never throws.
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isSessionId } from '../../../hooks/lib/session-store.mjs';
import { runFolderOf } from './run-state.mjs';

const MAX_JOURNAL_BYTES = 64 << 20;
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;
const refused = (message) => ({ ok: false, message });

/**
 * @param {{ record: { runId: string, projectDir: string, sessionId: string }, into: string, from?: string }} request
 *   into: the folder of the session that will resume; from: the folder of the session that holds the journal (default: the record's own,
 *   under the projects folder stored in the record, else projectsRoot; give it when the session folder was copied from another config dir)
 * @param {string} projectsRoot <config dir>/projects
 * @returns {{ ok: boolean, message: string }}
 */
export function adoptRun({ record, into, from }, projectsRoot) {
  try {
    const target = resolve(into);
    const root = resolve(projectsRoot);
    const inside = isAbsolute(into) && target.startsWith(`${root}${sep}`) && dirname(dirname(target)) === root && isSessionId(basename(target));
    if (!inside) return refused(`${into} is not inside ${root}: expected <projects>/<project>/<session id>`);
    const sourceFolder = from === undefined ? join(record.projectsRoot || root, record.projectDir, record.sessionId) : resolve(from);
    if (resolve(sourceFolder) === target) return { ok: true, message: 'same session: the journal is already where the Workflow tool looks, nothing to copy' };
    const sourceJournal = join(runFolderOf(sourceFolder, record.runId), 'journal.jsonl');
    const info = lstatSync(sourceJournal, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size > MAX_JOURNAL_BYTES) return refused(`no journal for ${record.runId} at ${sourceJournal} (swept after the retention period, or not copied from the other config dir)`);
    const targetFolder = runFolderOf(target, record.runId);
    const targetJournal = join(targetFolder, 'journal.jsonl');
    const existing = lstatSync(targetJournal, { throwIfNoEntry: false });
    if (existing !== undefined) {
      return { ok: true, message: `this session already has a journal for ${record.runId}; left as it is (${existing.size} bytes)` };
    }
    mkdirSync(targetFolder, { recursive: true, mode: FOLDER_MODE });
    copyFileSync(sourceJournal, targetJournal, constants.COPYFILE_EXCL);
    chmodSync(targetJournal, FILE_MODE);
    return { ok: true, message: `copied the journal of ${record.runId} (${info.size} bytes) into ${targetFolder}` };
  } catch (error) {
    return refused(`could not adopt ${record.runId}: ${error.message}`);
  }
}
