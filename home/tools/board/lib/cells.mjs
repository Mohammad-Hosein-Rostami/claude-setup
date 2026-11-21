// The cells every progress surface draws with (display design 4.1): the look of the terminal (glyphs, separators, colour), bars,
// durations, clocks, and fitting a row of parts to a width. Used by render.mjs (the status line rows) and tree.mjs (`/where`).
// Exports: lookOf(env, platform, columns) -> look; paint(text, state, look); cleanText(text, look); fitParts(parts, look) -> string;
// barText(shares, cells, look); durationText(minutes); clockOf(ms, nowMs, timeZone); STATE.
// Look: ASCII when CLAUDE_STATUS_ASCII=1, TERM=dumb, Windows without WT_SESSION and TERM_PROGRAM (the old console host), or a locale
// that is set and not UTF-8; colour off when NO_COLOR is set to any non-empty value (no-color.org) or TERM=dumb.
// Invariants: pure (no I/O); colour only for a state (warn, block) and every state also has a word in the text; in ASCII mode no
// byte above 0x7E is ever returned, since every outside text goes through cleanText; a fitted row is never wider than `columns`.
import { clockText, dayText, localDate } from '../../estimate/lib/local-clock.mjs';

/** The states a part may carry; ok has no colour (colour marks only what needs a look). */
export const STATE = { ok: 'ok', warn: 'warn', block: 'block', dim: 'dim' };
const COLOR_CODE = { warn: '\u001b[33m', block: '\u001b[31m', dim: '\u001b[2m' };
const RESET = '\u001b[0m';
const UNICODE = { done: '█', left: '░', over: '▓', now: '▒', sep: ' · ', bar: ' │ ', cut: '…' };
const ASCII = { done: '#', left: '.', over: '!', now: '>', sep: ' - ', bar: ' | ', cut: '...' };
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const NOT_ASCII = /[^ -~]/g;
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

/** @returns {string} the text in the colour of its state (no codes without colour, for ok, or for an unknown state) */
export const paint = (text, state, look) => (look.color && COLOR_CODE[state] ? `${COLOR_CODE[state]}${text}${RESET}` : text);

/** @returns {string} a text from outside (input, files) with control characters gone and, in ASCII mode, every other byte as `?` */
export function cleanText(text, look) {
  const plain = String(text ?? '').replace(CONTROL_CHARS, ' ');
  return look.ascii ? plain.replace(NOT_ASCII, '?') : plain;
}

const widthOf = (text) => [...text].length;
const sepOf = (part, look) => (part.bar ? look.glyph.bar : look.glyph.sep);

/** The parts joined, each painted; the last one that does not fit is cut and ends with the cut mark. */
function joined(parts, look) {
  let out = '';
  let used = 0;
  for (const [index, part] of parts.entries()) {
    const piece = `${index === 0 ? '' : sepOf(part, look)}${part.text}`;
    const room = look.columns - used;
    if (widthOf(piece) <= room) {
      out += index === 0 ? paint(part.text, part.state, look) : `${sepOf(part, look)}${paint(part.text, part.state, look)}`;
      used += widthOf(piece);
      continue;
    }
    const keep = Math.max(0, room - widthOf(look.glyph.cut));
    return `${out}${paint(`${[...piece].slice(0, keep).join('')}${look.glyph.cut}`.slice(0, Math.max(0, room)), part.state, look)}`;
  }
  return out;
}

/**
 * One row from its parts, fitted to look.columns: the parts with `drop` 0 always, then each level of `drop` in turn (1 first), a part
 * kept only when it still fits, so a low-priority short part can fill room a longer one left; whatever still overflows is cut.
 * @param {{ text: string, state?: string, drop?: number, bar?: boolean }[]} parts in display order; `bar` puts ` │ ` before the part
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
