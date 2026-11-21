// STATUS.md helper: the mechanical edits of the work table and the two lists, so the lead stops hand-editing them with sed.
// Usage (in the folder that holds STATUS.md, or --file <path> before the command; the clock is always the system's, tests pass `now`):
//   add <id> <item> <size>   new row at the end of the `## Work items` table, size S|M|L, started empty (rows are listed first)
//   start <id>               started = now, when work on the row begins; a set started or done cell is never changed
//   done <id> <evidence>     done = now (started too when it is empty: such a row costs 0); a set done cell is never changed
//   deliver "<what>"         a hand-over row `deliver:N | deliver: <what> | S | - | <now> | -`, N one above the highest
//   deliver --auto           the same, only when no work row is open and one was done after the last hand-over (the Stop hook
//                            hooks/status-deliver.mjs runs it); otherwise nothing changes and the message says why
//   rule "<text>" | decision "<text>"   bullet under `## Standing rules` (the owner's words) | `## Owner decisions`, dated
//   defect <id> "<conditions>"  the owner reported row <id> broken: `[defect <n>]` on its item; the second report adds a
//                            `rootcause:<id>` row and routes to root-cause first (defect.mjs)
//   add|start|done take several rows in one call, split by a lone `+` (`start` also takes plain ids; status-batch.mjs), all or none;
//   done takes predictor flags (--model, --effort, --files-planned, --suite-s, --review-rounds, --writers; status-predictors.mjs)
//   show                     where the job stands in at most 5 lines, the finish from the estimate cache (status-show.mjs)
//   log "<text>"             a dated line in STATUS.log.md beside STATUS.md, hidden from git (status-log.mjs); STATUS.md is not touched
// After a changed add|start|done the estimate refresh and the board refresh start at once (segment-cache.mjs refreshNow,
// board/lib/refresh.mjs startBoardRefresh).
// Exports: runStatus(argv, { cwd, now, sessionId, stateDir }) -> { code, message }; the CLI prints message (stdout for 0) and exits code.
// Invariants: touches only the one line it adds or changes; rows are only those of the one table under `## Work items` (header
// `id | item | size | started | done | evidence`, the contiguous rows below its separator, with or without outer pipes, found and
// read with the estimator's own findSection/rowCells/isTableRow in status-table.mjs, so code fences are skipped the same way), so a work row anywhere
// else is never edited; a missing section is never made below a code fence left open (it would be hidden: refused); ids and items starting `deliver:` are reserved for hand-overs; times are UTC to the minute, the format the
// estimate tool reads; exit 1 = refused, 2 = usage. After every edit that changed the file, noteTable records the table and links
// the session (CLAUDE_CODE_SESSION_ID) for the estimator; when that fails the edit still stands and the message says so.
// Safety: edits run one at a time (the lead runs Bash calls in parallel): an O_EXCL lock file `.<name>.status-lock` next to the file
// (hooks/lib/session-lock.mjs withSessionLock: it holds a pid and a token, a lock of a gone process older than 0.5 s is removed; after
// 1 s of waiting the edit is refused). status-file.mjs reads the file through one checked handle (a regular file of at most
// MAX_STATUS_BYTES) and renames a new temp file over it, so a STATUS.md that is a link, FIFO or anything but a regular file is
// refused. An id is one plain word starting with a letter or digit (ID), so no heading or bullet rides in on it.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BREAKER_SUFFIX, withSessionLock } from '../../hooks/lib/session-lock.mjs';
import { findSection, parseWorkItems, rowCells } from '../estimate/lib/items.mjs';
import { startBoardRefresh } from '../board/lib/refresh.mjs';
import { refreshNow } from '../estimate/lib/segment-cache.mjs';
import { noteTable, stateDir as defaultStateDir } from '../estimate/lib/table-store.mjs';
import { markDefect } from './defect.mjs';
import { rowGroups, runGroups } from './status-batch.mjs';
import { readStatusFile, replaceStatusFile } from './status-file.mjs';
import { appendLog } from './status-log.mjs';
import { recordPredictors, splitPredictorFlags } from './status-predictors.mjs';
import { showStatus } from './status-show.mjs';
import { DEFECT_TABLE, WORK_ITEMS, hiddenEndReason, insertRow, isEmpty, oneLine, rowIndex, rowToChange, sectionEnd, stamp, tableToEdit, writeRow } from './status-table.mjs';

const SIZES = ['S', 'M', 'L'];
const USAGE = 'usage: status.mjs [--file STATUS.md] add <id> <item> <size S|M|L> [+ <id> <item> <size> ...] | start <id> [<id> ...] | done <id> <evidence> [--model m --effort e ...] [+ <id> <evidence> ...] | deliver "<what>" | deliver --auto | rule "<text>" | decision "<text>" | defect <id> "<conditions>" | show | log "<text>"';
const READ_COMMANDS = ['show', 'log'];
// The row rules (they left the always-loaded home/CLAUDE.md, spec-p6 r9-text-procedures): printed with the usage text and after every add.
export const ROW_RULES = 'rows: every owner request and every owner correction becomes rows before work on it starts; list the whole job first, review, fixes and landing rows (`close:`) included; a correction\'s item starts `rework:`; a step found later is a new row at once; never fold steps into one row, never clear a done cell; `start` when work on a row begins, `done` with its evidence when it ends; a hand-over is recorded by itself when your turn ends with no open row, `deliver "<what>"` records one while rows stay open; the estimate tool keeps one time and says why when it moves.';
const REFRESH_COMMANDS = ['add', 'start', 'done'];
const SECTION_FOR = { rule: 'Standing rules', decision: 'Owner decisions' };
const ID = /^[A-Za-z0-9][\w.:-]{0,39}$/; // `7`, `17a`, `close:5`, `rework:12`, `deliver:3`; a leading `-` would read as a bullet
const RESERVED_ID = /^deliver:/i; // hand-over rows: only `deliver` writes them, numbered
const DELIVER_ID = /^deliver:(\d+)$/i;
const AUTO_DELIVER_WHAT = 'turn ended with no open row';
const LOCK_NAME_PARTS = /[^A-Za-z0-9_-]/g; // the lock's name part is the file name without .md, in the characters the lock helper takes
// `.<name>.status-lock`: no other tool uses it (a `<name>.lock` next to uv.md was uv's own lock file, and a stale one was deleted)
const LOCK_SUFFIX = '.status-lock';

function addRow(lines, [id, item, size]) {
  if (!ID.test(id ?? '') || !item || !SIZES.includes(size)) return { usage: `add needs <id> <item> <size ${SIZES.join('|')}> (id: letters, digits, _ . : -)` };
  if (RESERVED_ID.test(id)) return { error: 'ids starting deliver: are reserved for hand-overs; record one with `status.mjs deliver "<what>"`' };
  if (RESERVED_ID.test(oneLine(item))) return { error: 'an item starting deliver: makes the row a hand-over; record one with `status.mjs deliver "<what>"`' };
  const table = tableToEdit(lines);
  if (table.error) return table;
  if (rowIndex(lines, table, id) !== -1) return { error: `id ${id} already exists` };
  insertRow(lines, table, [id, oneLine(item), size, '', '', '']);
  return {};
}

function startRow(lines, [id], now) {
  if (!id) return { usage: 'start needs <id>' };
  const row = rowToChange(lines, id);
  if (row.error) return row;
  if (!isEmpty(row.cells[3])) return { error: `${id} is already started (${row.cells[3]}); a started cell is never changed` };
  row.cells[3] = stamp(now);
  writeRow(lines, row);
  return {};
}

function finishRow(lines, words, now) {
  const { words: [id, ...evidenceWords], error } = splitPredictorFlags(words);
  if (error) return { usage: error };
  const evidence = oneLine(evidenceWords.join(' '));
  if (!id || !evidence) return { usage: 'done needs <id> <evidence>' };
  const row = rowToChange(lines, id);
  if (row.error) return row;
  const neverStarted = isEmpty(row.cells[3]);
  if (neverStarted) row.cells[3] = stamp(now);
  row.cells[4] = stamp(now);
  row.cells[5] = isEmpty(row.cells[5]) ? evidence : `${row.cells[5]}; ${evidence}`;
  writeRow(lines, row);
  return neverStarted ? { note: `${id} was never started, so its work counts 0 minutes: run \`status.mjs start ${id}\` when work on a row begins` } : {};
}

/** `deliver:N`, N one above the highest numbered deliver row of the table. */
function nextDeliverId(lines, table) {
  const numbers = table.rows.map((i) => Number(DELIVER_ID.exec(rowCells(lines[i])[0])?.[1] ?? 0));
  return `deliver:${Math.max(0, ...numbers) + 1}`;
}

function appendDeliver(lines, what, now) {
  const table = tableToEdit(lines);
  if (table.error) return table;
  insertRow(lines, table, [nextDeliverId(lines, table), `deliver: ${what}`, 'S', '', stamp(now), '']);
  return {};
}

/** Why no hand-over is due, or null: due when the table reads cleanly, no work row is open and one was done after the last hand-over. */
function noHandOverReason(lines, now) {
  const { items, problems } = parseWorkItems(lines.join('\n'), now.getTime());
  if (problems.length > 0) return `the table has a problem at line ${problems[0].line}: ${problems[0].reason}`;
  const work = items.filter((item) => item.kind !== 'deliver');
  const open = work.find((item) => item.done === null);
  if (open) return `row ${open.id} is open`;
  const lastHandOver = Math.max(-Infinity, ...items.filter((item) => item.kind === 'deliver').map((item) => item.done));
  return work.some((item) => item.done > lastHandOver) ? null : 'no row was done since the last hand-over';
}

function deliverRow(lines, words, now) {
  if (words[0] === '--auto') {
    if (words.length > 1) return { usage: 'deliver --auto takes nothing after it' };
    const skip = noHandOverReason(lines, now);
    return skip === null ? appendDeliver(lines, AUTO_DELIVER_WHAT, now) : { skip };
  }
  const what = oneLine(words.join(' '));
  if (!what) return { usage: 'deliver needs "<what>" (or --auto)' };
  return appendDeliver(lines, what, now);
}

function addBullet(lines, kind, text, now) {
  const body = oneLine(text);
  if (!body) return { usage: `${kind} needs the text` };
  const bullet = kind === 'decision' ? `- ${stamp(now).slice(0, 10)} ${body}` : `- ${body}`;
  const section = findSection(lines, SECTION_FOR[kind]);
  if (lines.some((line, i) => section.visible[i] && line === bullet)) return {}; // a copy inside a code fence does not count
  if (section.start === -1) {
    const workItems = findSection(lines, WORK_ITEMS).start;
    const hidden = workItems === -1 ? hiddenEndReason(lines) : null;
    if (hidden !== null) return { error: hidden };
    lines.splice(workItems === -1 ? lines.length : workItems, 0, `## ${SECTION_FOR[kind]}`, bullet, '');
  } else if (section.openFence > section.start && section.openFence < section.end) {
    return { error: `unclosed code fence at line ${section.openFence + 1}, inside the \`## ${SECTION_FOR[kind]}\` section: a bullet added at its end would be hidden in the fence; close the fence first` };
  } else {
    lines.splice(sectionEnd(lines, section), 0, bullet);
  }
  return {};
}

const EDITS = {
  add: addRow,
  start: startRow,
  done: finishRow,
  deliver: deliverRow,
  rule: (lines, [text], at) => addBullet(lines, 'rule', text ?? '', at),
  decision: (lines, [text], at) => addBullet(lines, 'decision', text ?? '', at),
  defect: (lines, words) => markDefect(lines, words, DEFECT_TABLE),
};

/**
 * Reads, edits and writes the file; runs under the file's lock.
 * @returns {{code: number, message?: string, text?: string, changed?: boolean, note?: string, skip?: string}} code 0 with the new
 *   text, or the refusal (1) or usage error (2) and its message
 */
function editFile(file, edit) {
  let current;
  try {
    if (!lstatSync(file).isFile()) return { code: 1, message: `${file} is not a regular file (a link or special file): refused` };
    current = readStatusFile(file);
  } catch (error) {
    return { code: 1, message: `cannot read ${file}: ${error.code ?? error.message}` };
  }
  if (current.refused) return { code: 1, message: `${file} ${current.refused}: refused` };
  const original = current.text;
  const lines = original.split('\n');
  const outcome = edit(lines);
  if (outcome.usage) return { code: 2, message: outcome.usage };
  if (outcome.error) return { code: 1, message: outcome.error };
  const text = lines.join('\n');
  if (text !== original) replaceStatusFile(file, text);
  return { code: 0, text, changed: text !== original, note: outcome.note, skip: outcome.skip };
}

/** Records the table for the estimator (first-seen ids, the session's link); returns a note when that failed, else null. */
function recordTable(file, text, { sessionId, stateDir, now }) {
  const ids = parseWorkItems(text).items.map((item) => item.id);
  let failure = 'the store is busy or unusable';
  try {
    if (noteTable(stateDir, file, { sessionId, ids, nowMs: now.getTime() })) return null;
  } catch (error) {
    failure = error.code ?? error.message;
  }
  return `not recorded for the estimate (${failure}); the edit stands, the next estimate run records it`;
}

/** After a changed row edit: the predictors of each done row, then the estimate refresh at once; neither can fail the edit. */
function afterRowEdit(file, command, groups, { sessionId, stateDir, now, text }) {
  if (command === 'done') {
    const started = new Map(parseWorkItems(text).items.map((item) => [item.id, item.started]));
    for (const group of groups) {
      const { words, flags } = splitPredictorFlags(group);
      recordPredictors({ statusFile: file, folder: dirname(file), id: words[0], startedMs: started.get(words[0]) ?? null, nowMs: now.getTime(), flags }, { stateDir });
    }
  }
  // A run against another store (tests, probes) must not start a refresh of the real status line cache (P8).
  if (stateDir === defaultStateDir()) {
    refreshNow(file, sessionId);
    startBoardRefresh(sessionId, { cwd: dirname(file) });
  }
}

/** The lock path, or its breaker file's, when something other than a regular file sits there (never opened: a FIFO would block); else null. */
function notPlainLock(lock) {
  for (const path of [lock, `${lock}${BREAKER_SUFFIX}`]) {
    try {
      if (!lstatSync(path).isFile()) return path;
    } catch {
      // nothing at this name (or it cannot be read): not the cause
    }
  }
  return null;
}

/**
 * Runs one status command on a STATUS.md file.
 * @param {string[]} argv - arguments after the script name: `--file <path>` may come before the command, nothing else is a flag
 *   (`deliver --auto` is the one command option).
 * @param {{cwd?: string, now?: Date, sessionId?: string, stateDir?: string}} [options] - the folder that holds STATUS.md, the clock
 *   (tests pass a fixed one), the session to link (default CLAUDE_CODE_SESSION_ID) and the estimator's store (default
 *   ~/.claude/state/estimate).
 * @returns {{code: number, message: string}} 0 on success (also for `deliver --auto` with nothing to record, the message says why);
 *   1 when the edit is refused (also when another edit holds the lock for over a second); 2 for a usage error. A failure to record the
 *   table for the estimator is a note in the message, never a failed edit.
 */
export function runStatus(argv, { cwd = process.cwd(), now = new Date(), sessionId = process.env.CLAUDE_CODE_SESSION_ID, stateDir = defaultStateDir() } = {}) {
  const args = [...argv];
  const fileFlag = args[0] === '--file' ? args.splice(0, 2)[1] : undefined;
  const [command, ...rest] = args;
  if (!Object.hasOwn(EDITS, command) && !READ_COMMANDS.includes(command)) return { code: 2, message: `${USAGE}\n${ROW_RULES}` };
  const given = resolve(cwd, fileFlag ?? 'STATUS.md');
  let folder;
  try {
    folder = realpathSync(dirname(given));
  } catch (error) {
    return { code: 1, message: `cannot read ${given}: ${error.code ?? error.message}` };
  }
  const file = join(folder, basename(given));
  if (command === 'show') return showStatus(file);
  if (command === 'log') return appendLog(file, rest.join(' '), now);
  const lockName = basename(file).replace(/\.md$/i, '').replace(LOCK_NAME_PARTS, '_').slice(0, 100) || 'STATUS';
  const lockFile = `.${lockName}${LOCK_SUFFIX}`;
  const groups = rowGroups(command, rest);
  const result = withSessionLock(folder, lockName, () => editFile(file, (lines) => runGroups(groups, (words) => EDITS[command](lines, words, now))), { lockFile });
  if (result === undefined) {
    const blocking = notPlainLock(join(folder, lockFile));
    if (blocking !== null) return { code: 1, message: `${blocking} is not a plain lock file (a link, FIFO or folder): remove it` };
    return { code: 1, message: `${file} is busy (another status edit holds ${lockFile}) or its folder is not usable: run it again` };
  }
  if (result.code !== 0) return result;
  if (result.skip) return { code: 0, message: `${command} --auto: nothing recorded, ${result.skip} (${file})` };
  const notes = [result.note, result.changed ? recordTable(file, result.text, { sessionId, stateDir, now }) : null].filter(Boolean);
  if (result.changed && REFRESH_COMMANDS.includes(command)) afterRowEdit(file, command, groups, { sessionId, stateDir, now, text: result.text });
  const message = [`${command}: ok (${file})`, ...notes].join('; ');
  return { code: 0, message: command === 'add' ? `${message}\n${ROW_RULES}` : message };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { code, message } = runStatus(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(message);
  process.exitCode = code;
}
