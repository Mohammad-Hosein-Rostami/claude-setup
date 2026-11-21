// The cells every progress surface draws with (display design 4.1): the look of the terminal (glyphs, separators, colour), bars,
// durations, clocks, and fitting a row of parts to a width. Used by render.mjs (the status line rows) and tree.mjs (`/where`).
// Exports: lookOf(env, platform, columns) -> look; paint(text, state, look, bold); cleanText(text, look); cutWords(text, max, look);
// fitParts(parts, look) -> string; barText(shares, cells, look); durationText(minutes); clockOf(ms, nowMs, timeZone); STATE.
// Colour (spec-tui-2, basic ANSI 16 so the terminal theme maps them on dark and light themes), one meaning each: done green (done,
// passing, on track, ahead), run cyan (running now), warn yellow (attention soon), block red (needs action), wait magenta (waiting on
// the owner), dim (SGR 2, secondary text); bold only for the one most urgent part of a render (a part's `bold`).
// Look: ASCII when CLAUDE_STATUS_ASCII=1, TERM=dumb, Windows without WT_SESSION and TERM_PROGRAM (the old console host), or a locale
// that is set and not UTF-8; colour off when NO_COLOR is set to any non-empty value (no-color.org) or TERM=dumb.
// Invariants: pure (no I/O); colour only for a state and every state also has a word in the text (colour is never the only signal); in ASCII mode no
// byte above 0x7E is ever returned, since every outside text goes through cleanText; a fitted row is never wider than `columns`.
import { clockText, dayText, localDate } from '../../estimate/lib/local-clock.mjs';

/** The states a part may carry; ok has no colour. */
export const STATE = { ok: 'ok', done: 'done', run: 'run', warn: 'warn', block: 'block', wait: 'wait', dim: 'dim' };
const COLOR_CODE = { done: '\u001b[32m', run: '\u001b[36m', warn: '\u001b[33m', block: '\u001b[31m', wait: '\u001b[35m', dim: '\u001b[2m' };
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';
const UNICODE = { done: '█', left: '░', over: '▓', now: '▒', sep: ' · ', bar: ' │ ', cut: '…' };
const ASCII = { done: '#', left: '.', over: '!', now: '>', sep: ' - ', bar: ' | ', cut: '...' };
// C0 and C1 controls, and the invisible format characters (bidi overrides and isolates, zero-width marks, line and paragraph
// separators) that would reorder or hide neighbouring words of a row (review SEC-4)
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu;
const NOT_ASCII = /[^ -~]/g;
const WORD_BOUNDARY = /[\s\-/_]/;
const UTF8_LOCALE = /utf-?8/i;
const MIN_PER_HOUR = 60;
const WHOLE_HOURS_FROM_MIN = 10 * MIN_PER_HOUR;
const HOURS_FROM_MIN = 2 * MIN_PER_HOUR;
const MS_PER_MIN = 60_000;

/** True when the terminal cannot be trusted with the Unicode cells (design 4.1). */
function wantsAscii(env, platform) {
  if (env.CLAUDE_STATUS_ASCII === '1' || env.TERM === 'dumb') return true;
  if (platform === 'win32' && !env.WT_SESSION && !env.TERM_PROGRAM) return true;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return Boolean(locale) && !UTF8_LOCALE.test(locale);
}

/**
 * @param {Record<string, string | undefined>} env the process environment
 * @param {string} platform process.platform
 * @param {number} columns the width rows are fitted to
 * @returns {{ columns: number, ascii: boolean, color: boolean, glyph: typeof UNICODE }} the look of every row drawn for this terminal
 */
export function lookOf(env, platform, columns) {
  const ascii = wantsAscii(env, platform);
  return { columns, ascii, color: !env.NO_COLOR && env.TERM !== 'dumb', glyph: ascii ? ASCII : UNICODE };
}

/** @returns {string} the text in the colour of its state, bold when asked (no codes without colour, for ok, or an unknown state) */
export const paint = (text, state, look, bold = false) => (look.color && COLOR_CODE[state] ? `${bold ? BOLD : ''}${COLOR_CODE[state]}${text}${RESET}` : text);

/** @returns {string} a text from outside (input, files) with control characters gone and, in ASCII mode, every other byte as `?` */
export function cleanText(text, look) {
  const plain = String(text ?? '').replace(CONTROL_CHARS, ' ');
  return look.ascii ? plain.replace(NOT_ASCII, '?') : plain;
}

/**
 * A text cut to `max` characters at a word boundary, ending with the cut mark (the screenshot's "Write road" and "Land r9-tui, i"
 * were cut mid-word). A space, `-`, `/` or `_` is a boundary, taken only when at least two thirds of the room stays (so "Step1
 * impl: faster-slow-tests" keeps the lane name, review S1); with none there the text is cut inside the word.
 * @param {string} text an already cleaned text
 * @param {number} max the most characters kept, the cut mark included
 * @param {ReturnType<typeof lookOf>} look the terminal (its cut mark)
 * @returns {string} the text, at most `max` characters
 */
export function cutWords(text, max, look) {
  const chars = [...String(text ?? '').trim()];
  if (chars.length <= max) return chars.join('');
  const room = Math.max(0, max - [...look.glyph.cut].length);
  const head = chars.slice(0, room + 1);
  const boundary = head.findLastIndex((char) => WORD_BOUNDARY.test(char));
  const kept = (boundary >= Math.ceil((room * 2) / 3) ? head.slice(0, boundary) : chars.slice(0, room)).join('');
  return `${kept.replace(/[\s,;:.\-·]+$/u, '')}${look.glyph.cut}`;
}

const widthOf = (text) => [...text].length;
/** The text before a part: ` │ ` for `bar`, the part's own `join` (e.g. one space), else ` · `. */
const sepOf = (part, look) => (part.bar ? look.glyph.bar : part.join ?? look.glyph.sep);

/** The parts joined, each painted; the last one that does not fit is cut and ends with the cut mark. */
function joined(parts, look) {
  let out = '';
  let used = 0;
  for (const [index, part] of parts.entries()) {
    const piece = `${index === 0 ? '' : sepOf(part, look)}${part.text}`;
    const room = look.columns - used;
    if (widthOf(piece) <= room) {
      out += index === 0 ? paint(part.text, part.state, look, part.bold) : `${sepOf(part, look)}${paint(part.text, part.state, look, part.bold)}`;
      used += widthOf(piece);
      continue;
    }
    const keep = Math.max(0, room - widthOf(look.glyph.cut));
    return `${out}${paint(`${[...piece].slice(0, keep).join('')}${look.glyph.cut}`.slice(0, Math.max(0, room)), part.state, look, part.bold)}`;
  }
  return out;
}

/**
 * One row from its parts, fitted to look.columns: the parts with `drop` 0 always, then each level of `drop` in turn (1 first), a part
 * kept only when it still fits, so a low-priority short part can fill room a longer one left; whatever still overflows is cut.
 * @param {{ text: string, state?: string, drop?: number, bar?: boolean, join?: string, bold?: boolean }[]} parts in display order;
 *   `bar` puts ` │ ` before the part, `join` another text in place of ` · `, `bold` marks the render's one most urgent part
 * @param {ReturnType<typeof lookOf>} look the terminal
 * @returns {string} the row, at most look.columns visible characters
 */
export function fitParts(parts, look) {
  const present = parts.filter((part) => part.text !== '');
  const total = (list) => list.reduce((sum, part, index) => sum + widthOf(part.text) + (index === 0 ? 0 : widthOf(sepOf(part, look))), 0);
  const levels = [...new Set(present.map((part) => part.drop ?? 0))].filter((level) => level > 0).sort((a, b) => a - b);
  let kept = new Set(present.filter((part) => (part.drop ?? 0) === 0));
  for (const level of levels) {
    for (const part of present.filter((candidate) => candidate.drop === level)) {
      const trial = new Set([...kept, part]);
      if (total(present.filter((item) => trial.has(item))) <= look.columns) kept = trial;
    }
  }
  return joined(present.filter((part) => kept.has(part)), look);
}

/**
 * @param {{ done: number, over?: number, now?: number }} shares parts of the bar in [0, 1]: done (█), over plan (▓, drawn inside
 *   the done part's end), the current stage (▒, after done); whole cells only, so a full bar means all done
 * @param {number} cells the bar width
 * @param {ReturnType<typeof lookOf>} look the terminal
 * @returns {string} the bar
 */
export function barText({ done, over = 0, now = 0 }, cells, look) {
  const clamp = (share) => Math.min(1, Math.max(0, Number.isFinite(share) ? share : 0));
  const full = Math.floor(cells * clamp(done));
  const overCells = Math.min(full, Math.ceil(cells * clamp(over)));
  const nowCells = Math.min(cells - full, Math.ceil(cells * clamp(now)));
  const { glyph } = look;
  return glyph.done.repeat(full - overCells) + glyph.over.repeat(overCells) + glyph.now.repeat(nowCells) + glyph.left.repeat(cells - full - nowCells);
}

/** @returns {string} `40 min` below 2 h, `2 h 05` below 10 h, then `14 h` (design 4.1) */
export function durationText(minutes) {
  const min = Math.max(0, Math.round(minutes));
  if (min < HOURS_FROM_MIN) return `${min} min`;
  if (min >= WHOLE_HOURS_FROM_MIN) return `${Math.round(min / MIN_PER_HOUR)} h`;
  return `${Math.floor(min / MIN_PER_HOUR)} h ${String(min % MIN_PER_HOUR).padStart(2, '0')}`;
}

/**
 * @param {number} ms the instant (epoch ms)
 * @param {number} nowMs now (epoch ms)
 * @param {string} timeZone the one zone every clock of a render uses (audit case 12)
 * @param {boolean} [roundUp] round up to the next whole minute (a reset clock never shows early, audit case 10)
 * @returns {string} `16:05`, or `Fri 19:22` when the instant is not on today's local date
 */
export function clockOf(ms, nowMs, timeZone, roundUp = false) {
  const at = roundUp ? Math.ceil(ms / MS_PER_MIN) * MS_PER_MIN : ms;
  const day = localDate(at, timeZone) === localDate(nowMs, timeZone) ? '' : `${dayText(at, timeZone).split(' ')[0]} `;
  return `${day}${clockText(at, timeZone)}`;
}
