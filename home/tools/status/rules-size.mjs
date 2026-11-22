// The doctor's view of the standing-rules digest: for each STATUS.md in the estimate link store, how long the rules string that
// recall-digest.mjs prints after a resume or a compaction is, against RULES_CAP (status-digest.mjs). `token-audit.mjs --budget`
// prints these lines and `scripts/doctor.sh` (check_token_budget) shows them.
// Exports: rulesDigestBudget(stateDir) -> string[].
// Invariants: reads only, and the store only through its `stateDir` argument (tests pass a temp one); one line per distinct
// STATUS.md path, never silent (no linked STATUS.md is a line of its own); a STATUS.md that is gone (or a path that is not absolute
// on this machine, such as another system's) is skipped, one that cannot be read is a warn line; never throws; paths are shown as
// written (Windows ones too), only control characters become spaces so a path can never split the tab-separated line.
import { isAbsolute } from 'node:path';
import { readAllTables } from '../estimate/lib/table-store.mjs';
import { readStatusFile } from './status-file.mjs';
import { RULES_CAP, rulesText } from './status-digest.mjs';

const REASON_MAX_CHARS = 120;
const shown = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const reasonOf = (error) => shown(String(error?.code ?? error?.message ?? error)).slice(0, REASON_MAX_CHARS);

/** The status line of one STATUS.md, or null when the file is gone. */
function budgetLine(path) {
  let read;
  try {
    read = readStatusFile(path);
  } catch (error) {
    return error?.code === 'ENOENT' ? null : `warn\trules digest not measured (${reasonOf(error)}): ${shown(path)}`;
  }
  if (read.refused) return `warn\trules digest not measured (${shown(read.refused)}): ${shown(path)}`;
  const chars = rulesText(read.text, path).length;
  return `${chars > RULES_CAP ? 'warn' : 'ok'}\trules digest ${chars} chars (bound ${RULES_CAP}): ${shown(path)}`;
}

/**
 * One `<ok|warn>\t<message>` line per distinct STATUS.md the store links to.
 * @param {string} stateDir the estimate store (stateDir() of table-store.mjs for the owner's)
 * @returns {string[]} `ok|warn\trules digest <n> chars (bound 9000): <path>` per file; `ok\trules digest: no linked STATUS.md`
 *   when none is left; a store that cannot be read is one warn line
 */
export function rulesDigestBudget(stateDir) {
  let tables;
  try {
    tables = readAllTables(stateDir);
  } catch (error) {
    return [`warn\trules digest not measured: the link store ${shown(stateDir)} cannot be read (${reasonOf(error)})`];
  }
  const paths = [...new Set(tables.map((table) => table.path))].filter((path) => isAbsolute(path));
  const lines = paths.map(budgetLine).filter((line) => line !== null);
  return lines.length ? lines : ['ok\trules digest: no linked STATUS.md'];
}
