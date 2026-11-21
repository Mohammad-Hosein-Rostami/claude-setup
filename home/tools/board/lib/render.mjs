// The status line rows (spec-tui "Layout"; display design direction B for the alert, job and session rows): as many rows as the
// terminal's height allows (layout.mjs rowBudget, 3 to 12), in this order:
//   ! 1 needs you: a question, default in 0:40 · 5h out ~16:10 at this pace      (only when something needs him)
//   ALL █████░░░░░  36%  3 h 40 left · done by 17:45 · 85%: 18:20 · 10/21 rows   (work-row.mjs)
//   2 wf · 6 agents (4 run, 1 quiet) · 1 waiting on you 0:40 │ git 7 br · 2 dirty (layout.mjs countsRow; dropped first)
//   ▸ build r9-tui ... /  ├ impl-a ███▒░ ~60% ...                                 (layout.mjs workRows, agent-rows.mjs)
//   git main ✓ │ r9-a ↑2 ●3 impl-a ...                                             (git-rows.mjs, when rows are left)
//   Opus 5.5 high · ctx 99k 25% · 5h 54% left · 7d 69% left · acct work
// Exports: statusRows(view, look) -> string[] (never more than rowBudget(view.env) rows); sessionRow(view, look); alertRow(view, look) -> string | null; contextOf(window, env);
// paceOf(limitsFile, nowMs).
// Rules (audit cases of `certainty/statusline-audit.md`, fixes of display design 4.6): context is the input tokens of the last call
// against the auto-compact window (CLAUDE_CODE_AUTO_COMPACT_WINDOW, else the model's window), never `used_percentage`; `ctx ?` while
// `current_usage` is null or all zero (before the first call, after /compact: case 9); a limit shows `<1% left` rather than `0%`
// while usable and its reset clock rounded up with the weekday when not today (case 10); with no live 5 h window, the account's last
// sample with its age, else `5h ?` (case 1); `$` is not on the line (case 11); a table or tool error sits in the alert row (case 13);
// the 5 h pace (`out ~16:10 at this pace`) only when it comes before the reset, from two samples of one window, with the age of
// the newest when older than 5 min; it never notifies. The account name is the first part dropped, with git.
// Invariants: pure (no I/O); every outside text goes through cleanText; every row fits look.columns.
import { clockOf, cleanText, fitParts, STATE } from './cells.mjs';
import { gitRows } from './git-rows.mjs';
import { countsRow, rowBudget, workRows } from './layout.mjs';
import { WIDE_COLUMNS, workRow } from './work-row.mjs';

const TOKENS_PER_K = 1000;
const PERCENT = 100;
const MS_PER_S = 1000;
const MS_PER_MIN = 60_000;
const S_PER_MIN = 60;
const LONG_CTX_TOKENS = 60_000; // every tool call re-reads the context: from here batch calls (home/CLAUDE.md, token discipline)
const CLEAR_CTX_TOKENS = 150_000; // from here /clear before the next task
const LOW_LEFT_PCT = 30;
const OUT_LEFT_PCT = 10;
const SAMPLE_AGE_SHOWN_MIN = 5;
const MAX_NAME_CHARS = 24;
const MAX_BRANCH_CHARS = 32;
const ASKING_MARGIN_MS = 60 * MS_PER_S; // asking-marker.mjs STALE_MARGIN_S: expiresAt is the default's time plus this margin

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const wide = (look) => look.columns >= WIDE_COLUMNS;
const pad2 = (value) => String(value).padStart(2, '0');

/**
 * @param {object | undefined} window the input's `context_window`
 * @param {Record<string, string | undefined>} env CLAUDE_CODE_AUTO_COMPACT_WINDOW (set by settings/base.json `env`)
 * @returns {{ tokens: number | null, limit: number | null }} tokens null when not known yet (no call since start or /compact)
 */
export function contextOf(window, env) {
  const configured = Number.parseInt(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? '', 10);
  const limit = configured > 0 ? configured : isNumber(window?.context_window_size) && window.context_window_size > 0 ? window.context_window_size : null;
  const usage = window?.current_usage;
  if (usage === null) return { tokens: null, limit };
  if (usage !== undefined && typeof usage === 'object') {
    const sum = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((acc, key) => acc + (isNumber(usage[key]) ? usage[key] : 0), 0);
    return { tokens: sum > 0 ? sum : null, limit };
  }
  const total = window?.total_input_tokens;
  return { tokens: isNumber(total) && total > 0 ? total : null, limit };
}

function contextParts(window, env, look) {
  const { tokens, limit } = contextOf(window, env);
  if (tokens === null) return [{ text: 'ctx ?' }];
  const k = `${Math.round(tokens / TOKENS_PER_K)}k`;
  const pct = limit === null ? '' : `${Math.min(PERCENT, Math.round((PERCENT * tokens) / limit))}%`;
  const text = wide(look) && limit !== null ? `ctx ${k} of ${Math.round(limit / TOKENS_PER_K)}k (${pct})` : `ctx ${k}${pct ? ` ${pct}` : ''}`;
  if (tokens >= CLEAR_CTX_TOKENS) return [{ text, state: STATE.block }, { text: wide(look) ? '/clear before the next task' : '/clear soon', state: STATE.block, drop: 3 }];
  if (tokens >= LONG_CTX_TOKENS) return [{ text, state: STATE.warn }, { text: wide(look) ? 'long ctx: batch calls' : 'batch calls', state: STATE.warn, drop: 3 }];
  return [{ text }];
}

/** `54% left`, `<1% left` while some is left, `0% left` at the limit. */
function leftText(used) {
  const left = PERCENT - used;
  if (left <= 0) return '0% left';
  return left < 1 ? '<1% left' : `${Math.floor(left)}% left`;
}

const stateOfLeft = (used) => (PERCENT - used <= OUT_LEFT_PCT ? STATE.block : PERCENT - used <= LOW_LEFT_PCT ? STATE.warn : STATE.ok);

/** One live limit window: `5h 54% left` and, when wide, `, resets 17:40`; null when the window is absent. */
function windowPart(label, win, clock, look, drop) {
  if (!isNumber(win?.used_percentage)) return null;
  const reset = wide(look) && isNumber(win.resets_at) ? `, resets ${clockOf(win.resets_at * MS_PER_S, clock.nowMs, clock.timeZone, true)}` : '';
  return { text: `${label} ${leftText(win.used_percentage)}${reset}`, state: stateOfLeft(win.used_percentage), drop };
}

/** With no live 5 h window: this account's last sample with its age when its window has not reset since, else `5h ?`. */
function lastSeenFive(limitsFile, nowMs) {
  // The newest sample that had the window: a later sample taken while the input lacked it says nothing about its value.
  const sample = (Array.isArray(limitsFile?.samples) ? limitsFile.samples : []).findLast((s) => isNumber(s?.five_hour?.used_percentage));
  const five = sample?.five_hour;
  const current = isNumber(five?.used_percentage) && isNumber(sample.t) && (!isNumber(five.resets_at) || five.resets_at * MS_PER_S > nowMs);
  if (!current) return { text: '5h ?', state: STATE.dim };
  const ago = Math.max(0, Math.round((nowMs - sample.t) / MS_PER_MIN));
  return { text: `5h ${leftText(five.used_percentage)}, ${ago} min ago`, state: STATE.dim };
}

function gitPart(git, look) {
  if (git === null || typeof git !== 'object') return null;
  const branch = cleanText(git.branch ?? '?', look).slice(0, MAX_BRANCH_CHARS);
  const tree = Number.isInteger(git.changed) && git.changed > 0 ? `${git.changed} changed` : 'clean';
  const ab = wide(look) && Number.isInteger(git.ahead) && Number.isInteger(git.behind) && (git.ahead > 0 || git.behind > 0) ? ` +${git.ahead} -${git.behind}` : '';
  return { text: `${wide(look) ? 'git ' : ''}${branch}${ab}, ${tree}`, drop: 5 };
}

/**
 * The last row: model and effort, context, the two limit windows, git (only when no git row has room), the account.
 * @param {{ input: object, board: object | null, limitsFile: object | null, account: string | undefined, env: object, nowMs: number,
 *   timeZone: string }} view the status input and what was read for it
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string} the row
 */
export function sessionRow({ input, board, limitsFile, account, env, nowMs, timeZone, gitShown = false }, look) {
  const clock = { nowMs, timeZone };
  const name = cleanText(input.model?.display_name ?? input.model?.id ?? '?', look).slice(0, MAX_NAME_CHARS);
  const effort = typeof input.effort?.level === 'string' ? ` ${cleanText(input.effort.level, look).slice(0, 8)}` : '';
  const limits = input.rate_limits;
  const parts = [
    { text: `${name}${effort}` },
    ...contextParts(input.context_window, env, look),
    windowPart('5h', limits?.five_hour, clock, look, 0) ?? lastSeenFive(limitsFile, nowMs),
    windowPart('7d', limits?.seven_day, clock, look, 2),
    gitShown ? null : gitPart(board?.git ?? null, look),
    { text: account ? `acct ${cleanText(account, look).slice(0, MAX_NAME_CHARS)}` : 'account ?', drop: 6 },
  ];
  return fitParts(parts.filter(Boolean), look);
}

/**
 * The 5 h pace: when the newest sample and an older one of the same window (same reset) show use rising, the time the window runs
 * out at that rate, only when it comes before the reset.
 * @param {{ samples: object[] } | null} limitsFile the account's last-seen limits file (limits-store.mjs)
 * @param {number} nowMs now
 * @returns {{ outMs: number, ageMin: number } | null} null when it cannot be told or comes after the reset
 */
export function paceOf(limitsFile, nowMs) {
  const samples = (limitsFile?.samples ?? []).filter((s) => isNumber(s?.t) && isNumber(s.five_hour?.used_percentage) && isNumber(s.five_hour.resets_at));
  const newest = samples.at(-1);
  if (!newest) return null;
  const base = samples.find((s) => s.five_hour.resets_at === newest.five_hour.resets_at && s.t < newest.t);
  if (!base) return null;
  const rate = (newest.five_hour.used_percentage - base.five_hour.used_percentage) / (newest.t - base.t);
  if (!(rate > 0)) return null;
  const outMs = newest.t + (PERCENT - newest.five_hour.used_percentage) / rate;
  const resetMs = newest.five_hour.resets_at * MS_PER_S;
  return outMs < resetMs && resetMs > nowMs ? { outMs, ageMin: Math.round((nowMs - newest.t) / MS_PER_MIN) } : null;
}

/** `0:40` from a duration in ms. */
const minSec = (ms) => { const s = Math.max(0, Math.round(ms / MS_PER_S)); return `${Math.floor(s / S_PER_MIN)}:${pad2(s % S_PER_MIN)}`; };

function askingPart(asking, nowMs, look) {
  if (asking === null || typeof asking !== 'object') return null;
  const count = Number.isInteger(asking.count) && asking.count > 1 ? asking.count : 1;
  const question = asking.kind === 'question';
  const what = question ? (count > 1 ? `${count} questions` : 'a question') : 'a permission prompt';
  const leftMs = isNumber(asking.expiresAt) ? asking.expiresAt - ASKING_MARGIN_MS - nowMs : 0;
  const goes = question ? (wide(look) ? 'recommended taken in' : 'default in') : 'goes ahead in';
  const head = wide(look) ? (question ? 'WAITING FOR YOUR ANSWER' : 'WAITING FOR YOUR OK') : '1 needs you';
  return { text: `${head}: ${what}${leftMs > 0 ? `, ${goes} ${minSec(leftMs)}` : ''}`, state: STATE.block };
}

/** `estimate: table error at row A17` from the cached error text (segment-text.mjs errorSegment), never the finish slot. */
function estimateErrorPart(segment, look) {
  if (segment?.kind !== 'error' || typeof segment.text !== 'string') return null;
  const cause = segment.text.replace(/^done \? /, '');
  const words = cause.startsWith('row ') ? `table error at ${cause}` : cause === 'table' ? 'table error' : cause;
  return { text: `estimate: ${cleanText(words, look)}`, state: STATE.block, drop: 1 };
}

function pacePart(limitsFile, clock) {
  const pace = paceOf(limitsFile, clock.nowMs);
  if (pace === null) return null;
  const age = pace.ageMin > SAMPLE_AGE_SHOWN_MIN ? ` (seen ${pace.ageMin} min ago)` : '';
  return { text: `5h out ~${clockOf(pace.outMs, clock.nowMs, clock.timeZone)} at this pace${age}`, state: STATE.warn, drop: 2 };
}

/**
 * The alert row: what waits on the owner, an estimate error, the 5 h pace; null when there is nothing.
 * @param {{ asking: object | null, segment: object | null, limitsFile: object | null, nowMs: number, timeZone: string }} view
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string | null} the row starting with `! `
 */
export function alertRow({ asking, segment, limitsFile, nowMs, timeZone }, look) {
  const parts = [askingPart(asking, nowMs, look), estimateErrorPart(segment, look), pacePart(limitsFile, { nowMs, timeZone })].filter(Boolean);
  if (parts.length === 0) return null;
  const [first, ...rest] = parts;
  return fitParts([{ ...first, text: `! ${first.text}`, drop: 0 }, ...rest], look);
}

/**
 * All rows of one render: the alert row when something needs the owner, the job row, the counts row, the work rows, the git rows
 * and the session row, within the row budget (the counts row goes first when rows are short; work rows before git rows).
 * @param {{ input: object, segment: object | null, board: object | null, asking: object | null, limitsFile: object | null,
 *   account: string | undefined, env: object, nowMs: number, timeZone: string }} view
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string[]} 2 to 12 rows
 */
export function statusRows(view, look) {
  const { board, nowMs, timeZone } = view;
  const alert = alertRow(view, look);
  const fixed = alert === null ? 2 : 3;
  const free = rowBudget(view.env) - fixed;
  const withCounts = free >= 1;
  const rest = Math.max(0, free - (withCounts ? 1 : 0));
  const repo = board?.repo ?? null;
  const ctx = { nowMs, timeZone, at: board?.at, repo };
  const work = workRows(board, rest - (repo !== null && rest >= 3 ? 1 : 0), ctx, look);
  const git = gitRows(repo, rest - work.length, ctx, look);
  const asking = view.asking === null || typeof view.asking !== 'object' ? null : { ...view.asking, marginMs: ASKING_MARGIN_MS };
  return [
    ...(alert === null ? [] : [alert]),
    workRow({ segment: view.segment, runs: withCounts ? [] : board?.runs, nowMs, timeZone }, look),
    ...(withCounts ? [countsRow(board, asking, ctx, look)] : []), ...work, ...git,
    sessionRow({ ...view, gitShown: git.length > 0 }, look),
  ];
}
