// The status line rows (terminal-ui design A, owner decisions RC5, RC6 and RC8 of 2026-11-22): 2 rows when calm, at most 4 when busy.
//   ? ANSWER NEEDED · 1 question · recommended answer taken in 1:40                       (alert: only while a question or prompt waits)
//   ALL    ███░░░░░░░  40 min left · by 11:10 · +1h10 later        road final 2/4 · 2/5 lanes    (job: live work only, work-row.mjs)
//   agents 5 running · ! reviewer quiet 6 min · implementer over 12 min        all by 09:10    (only while an agent runs, layout.mjs)
//   git    main ✓ ↑44 · 3 lanes open · 1 dirty        Opus 5.5 high · ctx 25% · 5h 54% left · 7d 69% left · acct work
// Rows when they are short (layout.mjs rowBudget: 4, or 2 on a short terminal): the git and session row always (never blank: `git:
// loading` before the board's first refresh, `ctx ?` before the first call), then the alert, the job, the agents row. Every agent's
// own row, every worktree, the road's steps, reset clocks below 60 % used and the cost are in `/where` (tree.mjs).
// Exports: statusRows(view, look) -> string[] (never more than rowBudget(view.env) rows); sessionRow(view, look) (the git and session
// row; statusline.mjs prints it alone when drawing fails); alertRow(view, look) -> string | null; contextOf(window, env);
// paceOf(limitsFile, nowMs).
// Rules (audit cases of `certainty/statusline-audit.md`, fixes of display design 4.6): context is the input tokens of the last call
// against the auto-compact window (CLAUDE_CODE_AUTO_COMPACT_WINDOW, else the model's window), never `used_percentage`; `ctx ?` while
// `current_usage` is null or all zero (before the first call, after /compact: case 9); a limit shows `<1% left` rather than `0%`
// while usable, and from 60 % used (wide rows) its reset clock rounded up with the weekday when not today (case 10); with no live 5 h
// window, the account's last sample with its age, else no 5 h field (spec-tui-2); `$` is not on the line (case 11); an estimate
// error is on the job row in red (case 13); the 5 h pace (`5h out ~16:10`) only when it comes before the reset, from two samples
// of one window, with the age of the newest when older than 5 min; it never notifies. From 150k tokens `/clear` follows the context.
// Colour (RC5, cells.mjs): yellow needs a look (60-80 % used, behind the upstream, a quiet or slow agent, a later finish), red
// error or act now (over 80 % used, an estimate error), magenta waiting on the owner, labels and clocks dim, the rest (healthy
// values) in the default colour; no identity hues, no green, no blue.
// Invariants: pure (no I/O); every outside text goes through cleanText; every row fits look.columns.
import { clockOf, cleanText, fitParts, STATE } from './cells.mjs';
import { gitSummaryPart } from './git-rows.mjs';
import { agentsSummaryRow, rowBudget } from './layout.mjs';
import { roadPart, trendPart } from './stat-rows.mjs';
import { jobView, labelled, WIDE_COLUMNS, workRow } from './work-row.mjs';

const TOKENS_PER_K = 1000;
const PERCENT = 100;
const MS_PER_S = 1000;
const MS_PER_MIN = 60_000;
const S_PER_MIN = 60;
const CLEAR_CTX_TOKENS = 150_000; // from here /clear before the next task (home/CLAUDE.md, token discipline)
const WARN_USED_PCT = 60; // spec-tui-2: context or a limit 60-80 % used is yellow, over 80 % red, below 60 % the default colour
const BLOCK_USED_PCT = 80;
const SAMPLE_AGE_SHOWN_MIN = 5;
const MAX_NAME_CHARS = 24;
const MAX_EFFORT_CHARS = 8;
const ASKING_MARGIN_MS = 60 * MS_PER_S; // asking-marker.mjs STALE_MARGIN_S: expiresAt is the default's time plus this margin

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
/** A part whose leading label (`ctx`, `5h`, `7d`, `acct`) is dim and whose value keeps the part's state (spec-tui-3 session row). */
const dimLabel = (part, label) => ({ ...part, spans: [{ text: label, state: STATE.dim }, { text: part.text.slice(label.length), state: part.state }] });
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

/** @returns {string} the state of a share used: none below 60 %, yellow to 80 %, red above */
const stateOfUsed = (used) => (used > BLOCK_USED_PCT ? STATE.block : used >= WARN_USED_PCT ? STATE.warn : STATE.ok);

/** @returns {number | null} the context's percent of its window, or null when not known */
function contextPct(window, env) {
  const { tokens, limit } = contextOf(window, env);
  return tokens === null || limit === null ? null : Math.min(PERCENT, Math.round((PERCENT * tokens) / limit));
}

/** `ctx 25%` (`ctx 99k` without a window size), and `/clear` from CLEAR_CTX_TOKENS; `ctx ?` before the first call. */
function contextParts(window, env) {
  const { tokens } = contextOf(window, env);
  if (tokens === null) return [{ text: 'ctx ?', state: STATE.dim }];
  const used = contextPct(window, env);
  const state = used === null ? STATE.ok : stateOfUsed(used);
  const ctxPart = dimLabel({ text: `ctx ${used === null ? `${Math.round(tokens / TOKENS_PER_K)}k` : `${used}%`}`, state }, 'ctx');
  if (tokens < CLEAR_CTX_TOKENS) return [ctxPart];
  return [ctxPart, { text: '/clear', state: state === STATE.block ? STATE.block : STATE.warn, join: ' ', drop: 3 }];
}

/** `54% left`, `<1% left` while some is left, `0% left` at the limit. */
function leftText(used) {
  const left = PERCENT - used;
  if (left <= 0) return '0% left';
  return left < 1 ? '<1% left' : `${Math.floor(left)}% left`;
}

/** One live limit window: `5h 54% left` and, when wide and 60 % or more is used, `, resets 17:40`; null when the window is absent. */
function windowPart(label, win, clock, look, drop) {
  if (!isNumber(win?.used_percentage)) return null;
  const soon = wide(look) && win.used_percentage >= WARN_USED_PCT && isNumber(win.resets_at);
  const reset = soon ? `, resets ${clockOf(win.resets_at * MS_PER_S, clock.nowMs, clock.timeZone, true)}` : '';
  return dimLabel({ text: `${label} ${leftText(win.used_percentage)}${reset}`, state: stateOfUsed(win.used_percentage), drop }, label);
}

/** With no live 5 h window: this account's last sample with its age when its window has not reset since, else null (hidden). */
function lastSeenFive(limitsFile, nowMs) {
  // The newest sample that had the window: a later sample taken while the input lacked it says nothing about its value.
  const sample = (Array.isArray(limitsFile?.samples) ? limitsFile.samples : []).findLast((s) => isNumber(s?.five_hour?.used_percentage));
  const five = sample?.five_hour;
  const current = isNumber(five?.used_percentage) && isNumber(sample.t) && (!isNumber(five.resets_at) || five.resets_at * MS_PER_S > nowMs);
  if (!current) return null;
  const ago = Math.max(0, Math.round((nowMs - sample.t) / MS_PER_MIN));
  return { text: `5h ${leftText(five.used_percentage)}, ${ago} min ago`, state: STATE.dim };
}

/** The git part: the summary (git-rows.mjs) after its label; `git: loading` before the board's first refresh, else `git: no repository`. */
function gitPart(board, look) {
  const summary = gitSummaryPart(board?.repo ?? null, look);
  if (summary !== null) return labelled('git', summary, look);
  return { text: board?.at > 0 ? 'git: no repository' : 'git: loading', state: STATE.dim };
}

/** The session block: model and effort, context, the two limit windows, the 5 h pace, the account; right-aligned. */
function sessionParts({ input, limitsFile, account, env, nowMs, timeZone }, look) {
  const clock = { nowMs, timeZone };
  const name = cleanText(input.model?.display_name ?? input.model?.id ?? '?', look).slice(0, MAX_NAME_CHARS);
  const effort = typeof input.effort?.level === 'string' ? ` ${cleanText(input.effort.level, look).slice(0, MAX_EFFORT_CHARS)}` : '';
  const limits = input.rate_limits;
  return [
    { text: `${name}${effort}` },
    ...contextParts(input.context_window, env),
    windowPart('5h', limits?.five_hour, clock, look, 1) ?? lastSeenFive(limitsFile, nowMs), // null: the field hides
    pacePart(limitsFile, clock),
    windowPart('7d', limits?.seven_day, clock, look, 2),
    account ? dimLabel({ text: `acct ${cleanText(account, look).slice(0, MAX_NAME_CHARS)}`, drop: 6 }, 'acct') : { text: 'account ?', drop: 6 },
  ].filter(Boolean).map((part) => ({ ...part, right: true }));
}

/**
 * The last row: git on the left (one summary, git-rows.mjs gitSummaryPart), the session block on the right.
 * @param {{ input: object, board: object | null, limitsFile: object | null, account: string | undefined, env: object, nowMs: number,
 *   timeZone: string }} view the status input and what was read for it
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string} the row
 */
export function sessionRow(view, look) {
  return fitParts([gitPart(view.board, look), ...sessionParts(view, look)], look);
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

/** The alert's parts: `? ANSWER NEEDED` (bold), what waits, when the default is taken; all magenta (RC5: waiting on the owner). */
function askingParts(asking, nowMs, look) {
  const count = Number.isInteger(asking.count) && asking.count > 1 ? asking.count : 1;
  const question = asking.kind === 'question';
  const what = question ? `${count} ${count === 1 ? 'question' : 'questions'}` : 'a permission prompt';
  const leftMs = isNumber(asking.expiresAt) ? asking.expiresAt - ASKING_MARGIN_MS - nowMs : 0;
  const goes = question ? (wide(look) ? 'recommended answer taken in' : 'default in') : 'goes ahead in';
  return [
    { text: `? ${question ? 'ANSWER' : 'OK'} NEEDED`, state: STATE.wait, bold: true },
    { text: what, state: STATE.wait, drop: 1 },
    leftMs > 0 ? { text: `${goes} ${minSec(leftMs)}`, state: STATE.wait } : null,
  ].filter(Boolean);
}

/** The 5 h pace: `5h out ~16:10` (yellow), with the newest sample's age when old; null when it cannot be told. */
function pacePart(limitsFile, clock) {
  const pace = paceOf(limitsFile, clock.nowMs);
  if (pace === null) return null;
  const age = pace.ageMin > SAMPLE_AGE_SHOWN_MIN ? ` (seen ${pace.ageMin} min ago)` : '';
  return { text: `5h out ~${clockOf(pace.outMs, clock.nowMs, clock.timeZone)}${age}`, state: STATE.warn, drop: 2 };
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

/**
 * All rows of one render: the alert row while something waits on the owner, the job row, the agents row while an agent runs, and
 * the git and session row, within the row budget (the most useful first when rows are short).
 * @param {{ input: object, segment: object | null, board: object | null, asking: object | null, limitsFile: object | null,
 *   account: string | undefined, env: object, nowMs: number, timeZone: string }} view
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string[]} 1 to 4 rows: 2 when calm (job, git and session)
 */
export function statusRows(view, look) {
  const { board, nowMs, timeZone } = view;
  const clock = { nowMs, timeZone };
  const facts = board?.road ?? null;
  const road = roadPart(jobView(view.segment)?.road ?? null, facts, clock, look);
  const job = workRow({ segment: view.segment, facts, nowMs, timeZone, trend: trendPart(board?.trend, look), road }, look);
  const wanted = [alertRow(view, look), job, agentsSummaryRow(board, clock, look)].filter((row) => row !== null);
  return [...wanted.slice(0, rowBudget(view.env) - 1), sessionRow(view, look)];
}
