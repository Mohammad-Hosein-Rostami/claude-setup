// Status line (spec-tui; display design direction B): 2 to 12 rows by the terminal's height (LINES), drawn by
// tools/board/lib/render.mjs and fitted to COLUMNS - 5 (both read on every run). This file only reads and writes; render.mjs holds every rule of what is shown.
// Reads: the status input (stdin JSON), the estimate cache entry of the session's job (tools/estimate/lib/segment-cache.mjs), the
// session's board file (tools/board/lib/refresh.mjs), its asking marker (hooks/lib/asking-marker.mjs: a question waits 60 s, the
// board's idle refresh every 60 s would miss it), this account's last-seen limits file (tools/estimate/lib/limits-store.mjs) and the identity
// hues kept for the board's items (tools/board/lib/hue-store.mjs: a small file in the board cache, so an item's colour holds).
// Writes (spec-p5 `r9-statusline`, last-seen files): this account's limit sample when `rate_limits` changed (CLAUDE_ACCOUNT; none
// without it, so accounts never mix) and the session's last-seen cost (~/.claude/state/last-seen/<session>.json, the API-price
// equivalent `/where` shows; `$` is not on the line, audit case 11) and, when the board's items got new hues, that hue file.
// Spawns: only the claimed detached refreshes (the estimate cache's and the board's, one at a time each); no git, no launcher.
// Never blank: an error while drawing prints the session row and a `status line error: <reason>` line; an error before that (reading
// the input or the caches) prints the error line alone; exit 0 always (an empty output or a non-zero exit blanks the row).
import { readAsking } from './hooks/lib/asking-marker.mjs';
import { isSessionId, writeSessionFile } from './hooks/lib/session-store.mjs';
import { lookOf } from './tools/board/lib/cells.mjs';
import { identityOf } from './tools/board/lib/hue-store.mjs';
import { claimBoardRefresh, readBoard, startBoardRefresh } from './tools/board/lib/refresh.mjs';
import { sessionRow, statusRows } from './tools/board/lib/render.mjs';
import { systemTimeZone } from './tools/estimate/lib/local-clock.mjs';
import { readLimits, recordSample } from './tools/estimate/lib/limits-store.mjs';
import { estimateSegment } from './tools/estimate/lib/segment-cache.mjs';

// Claude Code sets COLUMNS and LINES for the command (statusline docs); without a usable value assume a plain 80-column terminal.
// It cuts every row at about COLUMNS - 5 (research-tui 1.1, probe and ccstatusline), so rows are fitted to that width.
const DEFAULT_COLUMNS = 80;
const CUT_MARGIN_COLUMNS = 5;
const MIN_COLUMNS = 20;
const MAX_ERROR_CHARS = 60;
const lastSeenDir = () => `${process.getBuiltinModule('node:os').homedir()}/.claude/state/last-seen`;

const terminalColumns = () => {
  const columns = Number.parseInt(process.env.COLUMNS ?? '', 10);
  return Math.max(MIN_COLUMNS, (columns > 0 ? columns : DEFAULT_COLUMNS) - CUT_MARGIN_COLUMNS);
};

/** The session's last-seen cost for `/where` (< 1 KB, temp file and rename through session-store.mjs); a failure is ignored. */
function writeLastSeen(d) {
  const cost = d.cost?.total_cost_usd;
  if (typeof cost !== 'number' || !isSessionId(d.session_id)) return;
  writeSessionFile(lastSeenDir(), d.session_id, JSON.stringify({ session: d.session_id, costUsd: cost, t: Date.now() }));
}

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
  recordSample(account, d.rate_limits);
  writeLastSeen(d);
  const duration = d.cost?.total_duration_ms;
  const segment = estimateSegment({
    projectDir: d.workspace?.project_dir ?? d.cwd,
    sessionId: d.session_id,
    // The project's STATUS.md is this session's job only when it changed during the session (audit case 2).
    projectSinceMs: typeof duration === 'number' ? nowMs - duration : nowMs,
  });
  const board = sessionBoard(d, nowMs);
  const view = {
    input: d, segment, board, identity: identityOf(d.session_id, board, { nowMs }), asking: isSessionId(d.session_id) ? readAsking(d.session_id, process.env, nowMs) : null,
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
