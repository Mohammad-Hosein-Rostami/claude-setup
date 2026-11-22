// The doctor's view of the standing-rules digest: for each STATUS.md the estimate store links to, how long the rules string that
// recall-digest.mjs prints at a session start, a resume or a compaction is, against RULES_CAP (status-digest.mjs).
// `token-audit.mjs --budget` prints these lines and `scripts/doctor.sh` (check_token_budget) shows them.
// Exports: rulesDigestBudget(stateDir) -> string[].
// Which files: every session link (session/<id>.json, the STATUS.md each session last edited with status.mjs, the file the digest
// reads first) and every table path of the store. The links are read as they are: readAllTables leaves a scratch table (a temp
// folder) out of the owner's store, but a link is what the digest follows, so a linked file is always measured.
// Levels: fail when always or project rules are left out (owner instructions lost after a start or a compaction), warn when only
// job rules are, ok when every rule is shown.
// Invariants: reads only, and the store only through its `stateDir` argument (tests pass a temp one); one line per distinct
// STATUS.md path, never silent (no linked STATUS.md is a line of its own); a STATUS.md that is gone (or a path that is not absolute
// on this machine, such as another system's) is skipped, one that cannot be read is a warn line; never throws; paths are shown as
// written (Windows ones too), only control characters become spaces so a path can never split the tab-separated line.
import { readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isSessionId } from '../../hooks/lib/session-store.mjs';
import { linkedStatusPath, readAllTables } from '../estimate/lib/table-store.mjs';
import { readStatusFile } from './status-file.mjs';
import { RULES_CAP, rulesDigest } from './status-digest.mjs';

const REASON_MAX_CHARS = 120;
const LINK_FOLDER = 'session'; // the session links of table-store.mjs: <stateDir>/session/<session-id>.json
const LINK_FILE = /^(.+)\.json$/;
const shown = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const reasonOf = (error) => shown(String(error?.code ?? error?.message ?? error)).slice(0, REASON_MAX_CHARS);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The STATUS.md paths of every session link in the store ([] without a link folder). */
function linkedPaths(stateDir) {
  let names;
  try {
    names = readdirSync(join(stateDir, LINK_FOLDER));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions = names.map((name) => LINK_FILE.exec(name)?.[1]).filter(isSessionId);
  return sessions.map((session) => linkedStatusPath(stateDir, session)).filter((path) => path !== null);
}

/** The status line of one STATUS.md, or null when the file is gone. */
function budgetLine(path) {
  let read;
  try {
    read = readStatusFile(path);
  } catch (error) {
    return error?.code === 'ENOENT' ? null : `warn\trules digest not measured (${reasonOf(error)}): ${shown(path)}`;
  }
  if (read.refused) return `warn\trules digest not measured (${shown(read.refused)}): ${shown(path)}`;
  const { text, hiddenAlways, hiddenJob } = rulesDigest(read.text, path);
  const size = `rules digest ${text.length} chars (bound ${RULES_CAP})`;
  if (hiddenAlways > 0) {
    return `fail\t${size}: ${plural(hiddenAlways, 'always or project rule')} and ${plural(hiddenJob, 'job rule')} not shown at a start or after a compaction (shorten or merge the always rules): ${shown(path)}`;
  }
  if (hiddenJob > 0) return `warn\t${size}, ${plural(hiddenJob, 'job rule')} not shown (the oldest): ${shown(path)}`;
  return `ok\t${size}: ${shown(path)}`;
}

/**
 * One `<ok|warn|fail>\t<message>` line per distinct STATUS.md the store links to.
 * @param {string} stateDir the estimate store (stateDir() of table-store.mjs for the owner's)
 * @returns {string[]} one line per file (see Levels in the header); `ok\trules digest: no linked STATUS.md` when none is left; a
 *   store that cannot be read is one warn line
 */
export function rulesDigestBudget(stateDir) {
  let paths;
  try {
    paths = [...linkedPaths(stateDir), ...readAllTables(stateDir).map((table) => table.path)];
  } catch (error) {
    return [`warn\trules digest not measured: the link store ${shown(stateDir)} cannot be read (${reasonOf(error)})`];
  }
  const lines = [...new Set(paths)].filter((path) => isAbsolute(path)).map(budgetLine).filter((line) => line !== null);
  return lines.length ? lines : ['ok\trules digest: no linked STATUS.md'];
}
