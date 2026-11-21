// The board CLI (spec-p5 `r9-board`): prints the session's board, one line per item, each cut to the terminal's width, and runs
// the detached refresh that status.mjs and the status line start.
// Usage: node board.mjs [--session <id>] [--columns <n>]        print (session default CLAUDE_CODE_SESSION_ID, columns default 80)
//        node board.mjs refresh --session <id> [--force]         refresh the board file (lib/refresh.mjs), print nothing
// Lines: `needs you: 2 questions · default in 0:45` first when the session waits on the owner; one per run
// (`api-redo · phase 2/4 Review · 2 Build, 1 Review · run`, `... · stopped? 34 min`); `+1 more run` when rows run out; the git line;
// one limits row per account from the last-seen limits files (never a switch of account: the board only shows them); `stale 40 s`
// when the last refresh ran over its budget.
// Exports: boardLines(board, limits, { columns, nowMs }) -> string[]. Exit 0 always for print (no board: one line says so), 2 usage.
// Invariants: reads only the board file and the limits files; every shown name was cut and stripped of control characters by its
// writer, and is cut again to the width here.
import { readdirSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { findTranscript, readBoard, refreshBoard } from './lib/refresh.mjs';
import { latestSample, limitsDir, readLimits } from '../estimate/lib/limits-store.mjs';

const DEFAULT_COLUMNS = 80;
const MAX_RUN_ROWS = 4;
const MS_PER_S = 1000;
const S_PER_MIN = 60;
const pad2 = (n) => String(n).padStart(2, '0');
const cut = (line, columns) => (line.length <= columns ? line : `${line.slice(0, columns - 1)}…`);
const clock = (epochMs) => { const d = new Date(epochMs); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const minSec = (ms) => { const s = Math.max(0, Math.round(ms / MS_PER_S)); return `${Math.floor(s / S_PER_MIN)}:${pad2(s % S_PER_MIN)}`; };
const STALE_MARGIN_MS = 60 * MS_PER_S; // the asking marker's expiresAt is the default's time plus this margin (asking-marker.mjs)

function askingLine(asking, nowMs) {
  const what = asking.kind === 'question' ? (asking.count > 1 ? `${asking.count} questions` : 'a question') : 'a permission prompt';
  return `needs you: ${what} · default in ${minSec(asking.expiresAt - STALE_MARGIN_MS - nowMs)}`;
}

function runLine(run) {
  const phase = run.phase ? ` · phase ${run.phaseIndex || '?'}/${run.phaseTotal ?? '?'} ${run.phase}` : '';
  const lanes = Object.entries(run.lanes ?? {}).map(([name, count]) => `${count} ${name}`).join(', ');
  const state = run.state === 'run' ? 'run' : `${run.state} ${run.quietMin} min`;
  return `${run.name ?? run.runId}${phase}${lanes ? ` · ${lanes}` : ''} · ${state}`;
}

function gitLine(git) {
  const ab = git.ahead === null ? '' : ` +${git.ahead} -${git.behind}`;
  return `git ${git.branch ?? '?'}${ab} · ${git.changed} changed`;
}

function limitLine({ account, sample }, nowMs) {
  const part = (label, window) => (window ? `${label} ${Math.round(window.used_percentage)}%${window.resets_at ? ` (resets ${clock(window.resets_at * MS_PER_S)})` : ''}` : `${label} ?`);
  const age = Number.isFinite(sample.t) ? `, seen ${Math.round((nowMs - sample.t) / (S_PER_MIN * MS_PER_S))} min ago` : '';
  return `limits ${account}: ${part('5h', sample.five_hour)}, ${part('7d', sample.seven_day)}${age}`;
}

/**
 * @param {object | null} board the session's board (readBoard)
 * @param {{ account: string, sample: object }[]} limits one newest sample per account
 * @param {{ columns?: number, nowMs?: number }} [view] the width and the clock
 * @returns {string[]} the lines, each at most `columns` wide
 */
export function boardLines(board, limits, { columns = DEFAULT_COLUMNS, nowMs = Date.now() } = {}) {
  const lines = [];
  if (board === null) lines.push('board: none yet for this session (it is written after the first status edit or render)');
  else {
    if (board.asking) lines.push(askingLine(board.asking, nowMs));
    const runs = board.runs ?? [];
    lines.push(...runs.slice(0, MAX_RUN_ROWS).map(runLine));
    if (runs.length > MAX_RUN_ROWS) lines.push(`+${runs.length - MAX_RUN_ROWS} more run${runs.length - MAX_RUN_ROWS === 1 ? '' : 's'}`);
    if (board.git) lines.push(gitLine(board.git));
    if (board.stale) lines.push(`stale ${Math.round((nowMs - board.stale.sinceMs) / MS_PER_S)} s`);
  }
  lines.push(...limits.map((limit) => limitLine(limit, nowMs)));
  return lines.map((line) => cut(line, columns));
}

/** The newest sample of every account with a last-seen limits file. */
function allLimits() {
  try {
    return readdirSync(limitsDir()).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length))
      .flatMap((account) => { const sample = latestSample(readLimits(account)); return sample ? [{ account, sample }] : []; });
  } catch {
    return []; // no limits folder yet
  }
}

function flagValue(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function main(args) {
  const session = flagValue(args, '--session') ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (args[0] === 'refresh') {
    refreshBoard({ session, transcriptPath: findTranscript(session), cwd: process.cwd() }, { force: args.includes('--force') });
    return 0;
  }
  const columns = Number(flagValue(args, '--columns') ?? DEFAULT_COLUMNS);
  if (!Number.isInteger(columns) || columns < 20) {
    console.error('usage: board.mjs [--session <id>] [--columns <n>=20+] | refresh --session <id> [--force]');
    return 2;
  }
  console.log(boardLines(readBoard(session), allLimits(), { columns }).join('\n'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
