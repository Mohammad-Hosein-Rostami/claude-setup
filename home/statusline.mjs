// Prints the status line: 2 rows when idle, at most 5 when busy, drawn from cache files and never blank.
// Rows (spec R18, owner decisions RC14 to RC20 of 2026-11-22): 2 rows when idle (git and session) and at most 5 when busy
// (alert, agents, 1 or 2 git rows, session; 4 from 12 LINES, 2 below), drawn by tools/board/lib/render.mjs and fitted to
// COLUMNS - 5 (both read on every run); colour by kind (branch, bar, time, session values) with yellow, red and magenta kept for
// needs a look, a problem and needs you; a light palette when the terminal says it is light or CLAUDE_STATUS_THEME=light. No job,
// step or estimate rows (plan 2026-11-24). This file only reads and writes; render.mjs holds every rule of what is shown.
// More: docs/how-it-works.md (section "Status line") and tools/board/README.md (an example of every row).
// Reads: the status input (stdin JSON), the session's board file (tools/board/lib/refresh.mjs), its asking marker
// (hooks/lib/asking-marker.mjs: a question waits 2 minutes (RC3), and the alert row must show at once, not after the board's idle
// refresh every 60 s) and this account's last-seen limits file (hooks/lib/limits-store.mjs).
// Writes (spec-p5 `r9-statusline`): this account's limit sample, with this session's id, when `rate_limits` brought news that no
// other session's newer sample already holds (CLAUDE_ACCOUNT; none without it, so accounts never mix); `$` is not on the line.
// Spawns: only the claimed detached board refresh (one at a time); no git, no launcher.
// Never blank: an error while drawing prints the session row and a `status line error: <reason>` line; an error before that (reading
// the input or the caches) prints the error line alone; exit 0 always (an empty output or a non-zero exit blanks the row).
import { readAsking } from './hooks/lib/asking-marker.mjs';
import { readLimits, recordSample } from './hooks/lib/limits-store.mjs';
import { isSessionId } from './hooks/lib/session-store.mjs';
import { lookOf } from './tools/board/lib/cells.mjs';
import { systemTimeZone } from './tools/board/lib/local-clock.mjs';
import { claimBoardRefresh, readBoard, startBoardRefresh } from './tools/board/lib/refresh.mjs';
import { sessionRow, statusRows } from './tools/board/lib/render.mjs';

// Claude Code sets COLUMNS and LINES for the command (statusline docs); without a usable value assume a plain 80-column terminal.
// It cuts every row at about COLUMNS - 5 (research-tui 1.1, probe and ccstatusline), so rows are fitted to that width.
const DEFAULT_COLUMNS = 80;
const CUT_MARGIN_COLUMNS = 5;
const MIN_COLUMNS = 20;
const MAX_ERROR_CHARS = 60;

const terminalColumns = () => {
  const columns = Number.parseInt(process.env.COLUMNS ?? '', 10);
  return Math.max(MIN_COLUMNS, (columns > 0 ? columns : DEFAULT_COLUMNS) - CUT_MARGIN_COLUMNS);
};

/** The board of the session, after starting its refresh when one is due (claimed first, so renders never stack refreshes). */
function sessionBoard(d, nowMs) {
  if (!isSessionId(d.session_id)) return null;
  const cwd = d.workspace?.current_dir ?? d.cwd;
  if (typeof cwd === 'string' && claimBoardRefresh(d.session_id, { nowMs })) startBoardRefresh(d.session_id, { cwd, force: true });
  return readBoard(d.session_id);
}

/** The rows for one status input. */
function render(d) {
  const nowMs = Date.now();
  const account = process.env.CLAUDE_ACCOUNT;
  recordSample(account, d.rate_limits, { session: d.session_id });
  const board = sessionBoard(d, nowMs);
  const view = {
    input: d, board, asking: isSessionId(d.session_id) ? readAsking(d.session_id, process.env, nowMs) : null,
    limitsFile: readLimits(account), account, env: process.env, nowMs, timeZone: systemTimeZone(),
  };
  const look = lookOf(process.env, process.platform, terminalColumns());
  try {
    return statusRows(view, look).join('\n');
  } catch (error) {
    return `${sessionRow({ ...view, board: null }, look)}\n${errorLine(error)}`; // a broken board or row: the session row still shows
  }
}

/** One plain line naming an error (printable ASCII only, cut). */
const errorLine = (error) => `status line error: ${String(error?.message ?? error).replace(/[^ -~]/g, ' ').slice(0, MAX_ERROR_CHARS)}`;

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    let d = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') d = parsed;
    } catch {
      // not JSON: render what can be shown without the input
    }
    console.log(render(d));
  } catch (error) {
    console.log(errorLine(error));
  }
  process.exitCode = 0;
});
