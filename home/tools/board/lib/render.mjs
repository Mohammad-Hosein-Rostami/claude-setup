// The status line rows (spec R18, owner decisions RC14 to RC18 of 2026-11-22): at most 5 rows when busy, 2 when idle, at 100 columns:
//   ? ANSWER NEEDED · 1 question · recommended answer taken in 1:40                 (alert: only while a question or prompt waits)
//   agents  5 running · 1 done · ! reviewer quiet 6 min                          (only while an agent runs, layout.mjs)
//   git     claude-setup  main  ↑2 to push · 1 staged · 3 changed · 1 new · stash 1   (git-rows.mjs gitLineRows)
//   lanes   r18-git ↑2 ~3 implementer · r18-est ↑4 ready to land                           (git row 2: lanes or a 2nd repo)
//   session Opus 5.5 high · context 29% · 5h 90% left, empty ~22:32 · 7d 47% left · acct mine
// Budget (layout.mjs rowBudget: 6, 4 or 2 by LINES): over it the rows are kept in this order: session, git 1, alert, agents, git 2;
// they print top to bottom as above. Never blank: `git loading` before the board's first refresh, `context ?` before the first call.
// No job, step or estimate rows (plan 2026-11-24: estimates and job machinery removed).
// Exports: statusRows(view, look) -> string[] (never more than rowBudget(view.env) rows); sessionRow(view, look) (statusline.mjs
// prints it alone when drawing fails); alertRow(view, look) -> string | null; contextOf(window, env); paceOf(limitsFile, nowMs).
// Rules (audit cases of `certainty/statusline-audit.md`, fixes of display design 4.6): context is the input tokens of the last call
// against the auto-compact window (CLAUDE_CODE_AUTO_COMPACT_WINDOW, else the model's window), never `used_percentage`; `context ?`
// while `current_usage` is null or all zero (before the first call, after /compact: case 9); a limit shows `<1% left` rather than
// `0%` while usable, and from 60 % used its reset clock rounded up with the weekday when not today (case 10); with no live 5 h
// window, the account's last sample with its age, else no 5 h field (spec-tui-2); `$` is not on the line (case 11); the 5 h pace
// (`, empty ~16:10`) only while still ahead and before the reset (an empty window or a passed pace shows `, resets 14:00`, R33), from two samples of one window, with the age of the newest when older
// than 5 min; it never notifies. From 150k tokens `/clear` follows the context. The session row drops acct, then 7d, then the 5 h
// clock.
// Colour (cells.mjs, RC14): model, effort, context and limit values `session`, clocks `time`, labels dim; yellow from 60 % used,
// red over 80 %, the pace yellow, the alert magenta.
// Invariants: pure (no I/O); every outside text goes through cleanText; every row fits look.columns.
import { clockOf, cleanText, fitParts, LABEL_FROM_COLUMNS, labelled, STATE } from './cells.mjs';
import { gitLineRows } from './git-rows.mjs';
import { agentsSummaryRow, rowBudget } from './layout.mjs';

const TOKENS_PER_K = 1000;
const PERCENT = 100;
const MS_PER_S = 1000;
const MS_PER_MIN = 60_000;
const S_PER_MIN = 60;
const CLEAR_CTX_TOKENS = 150_000; // from here /clear before the next task (home/CLAUDE.md, token discipline)
const WARN_USED_PCT = 60; // spec-tui-2: context or a limit 60-80 % used is yellow, over 80 % red, below 60 % the session colour
const BLOCK_USED_PCT = 80;
const SAMPLE_AGE_SHOWN_MIN = 5;
const MAX_NAME_CHARS = 24;
const MAX_EFFORT_CHARS = 8;
const ASKING_MARGIN_MS = 60 * MS_PER_S; // asking-marker.mjs STALE_MARGIN_S: expiresAt is the default's time plus this margin
/** The rows kept when the budget is short, most useful first (spec R18); they print in ROW_ORDER. */
const KEEP_ORDER = ['session', 'git1', 'alert', 'agents', 'git2'];
const ROW_ORDER = ['alert', 'agents', 'git1', 'git2', 'session'];

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
/** A part whose leading label (`context`, `5h`, `7d`, `acct`) is dim and whose value keeps the part's state. */
const dimLabel = (part, label) => ({ ...part, spans: [{ text: label, state: STATE.dim }, { text: part.text.slice(label.length), state: part.state }] });
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

/** @returns {string} the state of a share used: the session colour below 60 %, yellow to 80 %, red above */
const stateOfUsed = (used) => (used > BLOCK_USED_PCT ? STATE.block : used >= WARN_USED_PCT ? STATE.warn : STATE.session);

/** @returns {number | null} the context's percent of its window, or null when not known */
function contextPct(window, env) {
  const { tokens, limit } = contextOf(window, env);
  return tokens === null || limit === null ? null : Math.min(PERCENT, Math.round((PERCENT * tokens) / limit));
}

/** `context 25%` (`context 99k` without a window size), and `/clear` from CLEAR_CTX_TOKENS; `context ?` before the first call. */
function contextParts(window, env) {
  const { tokens } = contextOf(window, env);
  if (tokens === null) return [{ text: 'context ?', state: STATE.dim }];
  const used = contextPct(window, env);
  const state = used === null ? STATE.session : stateOfUsed(used);
  const ctxPart = dimLabel({ text: `context ${used === null ? `${Math.round(tokens / TOKENS_PER_K)}k` : `${used}%`}`, state }, 'context');
  if (tokens < CLEAR_CTX_TOKENS) return [ctxPart];
  return [ctxPart, { text: '/clear', state: state === STATE.block ? STATE.block : STATE.warn, join: ' ' }];
}

/** `54% left`, `<1% left` while some is left, `0% left` at the limit. */
function leftText(used) {
  const left = PERCENT - used;
  if (left <= 0) return '0% left';
  return left < 1 ? '<1% left' : `${Math.floor(left)}% left`;
}

/** One live limit window: `5h 54% left`; null when the window is absent. */
function windowPart(label, win, drop) {
  if (!isNumber(win?.used_percentage)) return null;
  return dimLabel({ text: `${label} ${leftText(win.used_percentage)}`, state: stateOfUsed(win.used_percentage), drop }, label);
}

/**
 * The 5 h clock after its value: the pace `, empty ~16:10` (yellow) while it is still ahead and comes before the reset, else
 * from 60 % used `, resets 17:40`. A window already empty, or a pace already passed, shows the reset (owner R33: the reset
 * clock stands beside `5h 0% left`, never a past `empty ~` time).
 */
function fiveClockPart(limitsFile, win, clock) {
  const pace = paceOf(limitsFile, clock.nowMs);
  const empty = isNumber(win?.used_percentage) && win.used_percentage >= PERCENT;
  if (pace !== null && !empty && pace.outMs > clock.nowMs) {
    const age = pace.ageMin > SAMPLE_AGE_SHOWN_MIN ? ` (seen ${pace.ageMin} min ago)` : '';
    return { text: `, empty ~${clockOf(pace.outMs, clock.nowMs, clock.timeZone)}${age}`, state: STATE.warn, join: '', drop: 1 };
  }
  if (!isNumber(win?.used_percentage) || win.used_percentage < WARN_USED_PCT) return null;
  return resetsPart(win.resets_at, clock);
}

/** `, resets 17:40` (weekday when not today) for a reset in the future, else null. */
function resetsPart(resetsAtS, clock) {
  if (!isNumber(resetsAtS) || resetsAtS * MS_PER_S <= clock.nowMs) return null;
  const at = clockOf(resetsAtS * MS_PER_S, clock.nowMs, clock.timeZone, true);
  return { text: `, resets ${at}`, spans: [{ text: ', resets ' }, { text: at, state: STATE.time }], join: '', drop: 1 };
}

/**
 * With no live 5 h window: this account's last sample with its age when its window has not reset since, plus its reset clock
 * from 60 % used (R33), else null (hidden).
 */
function lastSeenFive(limitsFile, clock) {
  const { nowMs } = clock;
  // The newest sample that had the window: a later sample taken while the input lacked it says nothing about its value.
  const sample = (Array.isArray(limitsFile?.samples) ? limitsFile.samples : []).findLast((s) => isNumber(s?.five_hour?.used_percentage));
  const five = sample?.five_hour;
  const current = isNumber(five?.used_percentage) && isNumber(sample.t) && (!isNumber(five.resets_at) || five.resets_at * MS_PER_S > nowMs);
  if (!current) return null;
  const ago = Math.max(0, Math.round((nowMs - sample.t) / MS_PER_MIN));
  const reset = five.used_percentage >= WARN_USED_PCT ? resetsPart(five.resets_at, clock)?.text ?? '' : '';
  return { text: `5h ${leftText(five.used_percentage)}, ${ago} min ago${reset}`, state: STATE.dim };
}

/** The session row's parts: model and effort, context, the two limit windows with the 5 h clock, the account. */
function sessionParts({ input, limitsFile, account, env, nowMs, timeZone }, look) {
  const clock = { nowMs, timeZone };
  const name = cleanText(input.model?.display_name ?? input.model?.id ?? '?', look).slice(0, MAX_NAME_CHARS);
  const effort = typeof input.effort?.level === 'string' ? ` ${cleanText(input.effort.level, look).slice(0, MAX_EFFORT_CHARS)}` : '';
  const five = input.rate_limits?.five_hour;
  return [
    labelled('session', { text: `${name}${effort}`, state: STATE.session }, look),
    ...contextParts(input.context_window, env),
    windowPart('5h', five, 0) ?? lastSeenFive(limitsFile, clock), // null: the field hides
    windowPart('5h', five, 0) === null ? null : fiveClockPart(limitsFile, five, clock),
    windowPart('7d', input.rate_limits?.seven_day, 2),
    account ? dimLabel({ text: `acct ${cleanText(account, look).slice(0, MAX_NAME_CHARS)}`, state: STATE.session, drop: 3 }, 'acct')
      : { text: 'acct ?', state: STATE.dim, drop: 3 },
  ].filter(Boolean);
}

/**
 * The session row: model and effort, context, the 5 h and 7 d limits, the account.
 * @param {{ input: object, limitsFile: object | null, account: string | undefined, env: object, nowMs: number, timeZone: string }} view
 *   the status input and what was read for it
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string} the row
 */
export function sessionRow(view, look) {
  return fitParts(sessionParts(view, look), look);
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

/** The alert's parts: `? ANSWER NEEDED` (bold), what waits, when the default is taken; all magenta (needs you). */
function askingParts(asking, nowMs, look) {
  const count = Number.isInteger(asking.count) && asking.count > 1 ? asking.count : 1;
  const question = asking.kind === 'question';
  const what = question ? `${count} ${count === 1 ? 'question' : 'questions'}` : 'a permission prompt';
  const leftMs = isNumber(asking.expiresAt) ? asking.expiresAt - ASKING_MARGIN_MS - nowMs : 0;
  const goes = question ? (look.columns >= LABEL_FROM_COLUMNS ? 'recommended answer taken in' : 'default in') : 'goes ahead in';
  return [
    { text: `? ${question ? 'ANSWER' : 'OK'} NEEDED`, state: STATE.wait, bold: true },
    { text: what, state: STATE.wait, drop: 1 },
    leftMs > 0 ? { text: `${goes} ${minSec(leftMs)}`, state: STATE.wait } : null,
  ].filter(Boolean);
}

/**
 * The alert row: only while a question or a permission prompt waits on the owner (the asking marker).
 * @param {{ asking: object | null, nowMs: number }} view
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string | null} the row starting with `? `, or null
 */
export function alertRow({ asking, nowMs }, look) {
  if (asking === null || typeof asking !== 'object') return null;
  return fitParts(askingParts(asking, nowMs, look), look);
}

/** The session folder as the no-repository row names it: `~` for the home folder, else its last name; null when unknown. */
function folderShown(input, env) {
  const cwd = input?.workspace?.current_dir ?? input?.cwd;
  if (typeof cwd !== 'string' || cwd === '') return null;
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const home = String(env.HOME ?? env.USERPROFILE ?? '').replace(/[\\/]+$/, '');
  return home !== '' && trimmed === home ? '~' : trimmed.split(/[\\/]/).at(-1) || null;
}

/** The rows to print: the non-null ones of `rows`, as many as the budget allows in KEEP_ORDER, printed in ROW_ORDER. */
function kept(rows, budget) {
  const keep = new Set(KEEP_ORDER.filter((key) => rows[key] !== null && rows[key] !== undefined).slice(0, budget));
  return ROW_ORDER.filter((key) => keep.has(key));
}

/**
 * All rows of one render within the row budget (spec R18): alert, agents, git 1, git 2, session.
 * @param {{ input: object, board: object | null, asking: object | null, limitsFile: object | null,
 *   account: string | undefined, env: object, nowMs: number, timeZone: string }} view
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string[]} 2 to 5 rows: 2 when idle in a repository with no lanes (git and session)
 */
export function statusRows(view, look) {
  const { board, nowMs } = view;
  const folder = folderShown(view.input, view.env);
  const [git1, git2 = null] = gitLineRows(board, 2, look, folder);
  const rows = {
    alert: alertRow(view, look), agents: agentsSummaryRow(board, { nowMs }, look),
    git1, git2, session: sessionRow(view, look),
  };
  const budget = rowBudget(view.env);
  const shown = kept(rows, budget);
  // git 2 left out: git 1 is drawn alone, so it counts what it cannot show
  if (git2 !== null && !shown.includes('git2')) [rows.git1] = gitLineRows(board, 1, look, folder);
  return shown.map((key) => rows[key]);
}
