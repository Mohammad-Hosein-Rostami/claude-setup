// The cells every progress surface draws with (display design 4.1): the look of the terminal (glyphs, separators, colour), bars,
// durations, clocks, and fitting a row of parts to a width. Used by render.mjs (the status line rows) and tree.mjs (`/where`).
// Exports: lookOf(env, platform, columns) -> look; paint(text, state, look, bold); cleanText(text, look); cutWords(text, max, look);
// fitParts(parts, look) -> string; barText(shares, cells, look); durationText(minutes); clockOf(ms, nowMs, timeZone); STATE;
// hueState(hue) -> state; HUE_CODES.
// Colour (spec-tui-2, basic ANSI 16 so the terminal theme maps them on dark and light themes), one meaning each: done green (done,
// passing, on track, ahead), run cyan (running now), warn yellow (attention soon), block red (needs action), wait magenta (waiting on
// the owner), dim (SGR 2, secondary text); a part's `bold` marks the render's one most urgent part, and bold also stands for `ALL`,
// main's git row and, on a 16-colour terminal, two of the identity hues.
// Identity and section colours (spec-tui-3, "which is where"): a work item's hue (`hueState(n)`, identity.mjs picks n) is one of
// HUE_CODES in the 256-colour cube, never a state's code; on a 16-colour terminal (TERM and COLORTERM name no 256 or true colour)
// the hues cycle bold, underline, plain (WT_SESSION, Windows Terminal, counts as 256-colour); without colour none. `road` is basic blue (the road row's label), `strong` bold with no
// colour (`ALL`, main's git row). A part may carry `spans` (texts in order whose join is its text, each with its own state).
// Look: ASCII when CLAUDE_STATUS_ASCII=1, TERM=dumb, Windows without WT_SESSION and TERM_PROGRAM (the old console host), or a locale
// that is set and not UTF-8; colour off when NO_COLOR is set to any non-empty value (no-color.org) or TERM=dumb.
// Invariants: pure (no I/O); colour only for a state and every state also has a word in the text (colour is never the only signal); in ASCII mode no
// byte above 0x7E is ever returned, since every outside text goes through cleanText; a fitted row is never wider than `columns`.
import { clockText, dayText, localDate } from '../../estimate/lib/local-clock.mjs';

/** The states a part may carry; ok has no colour. */
export const STATE = { ok: 'ok', done: 'done', run: 'run', warn: 'warn', block: 'block', wait: 'wait', dim: 'dim', road: 'road', strong: 'strong' };
const COLOR_CODE = {
  done: '\u001b[32m', run: '\u001b[36m', warn: '\u001b[33m', block: '\u001b[31m', wait: '\u001b[35m', dim: '\u001b[2m', road: '\u001b[34m',
  strong: '\u001b[1m',
};
/**
 * The identity hues, xterm 256-colour indexes chosen for the best contrast on both a #1e1e1e and a #ffffff background. Measured WCAG
 * ratios (dark / white): 31 4.04 / 4.13, 166 4.39 / 3.80, 99 4.06 / 4.11, 64 3.93 / 4.24, 197 4.30 / 3.88, 133 4.03 / 4.13, so 3.80 to
 * 4.39 over both; no colour reaches 4.5:1 on both (the best any cube colour reaches on both is 4.06): blue, orange, violet, green,
 * pink, orchid.
 */
export const HUE_CODES = [31, 166, 99, 64, 197, 133];
/** A finished agent keeps its row this long; identity.mjs lets it hold a hue only that long too. */
export const DONE_SHOWN_MS = 30_000;
const HUE_STATE = /^hue:(\d+)$/;
/** The 16-colour stand-ins of the hues, cycled so that with the marker shape (hue % 3) each of the six hues looks different. */
const HUE_STYLES_16 = ['\u001b[1m', '\u001b[4m', ''];
const COLOR_TERM = /256|truecolor|24bit|direct/i;
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';
const UNICODE = { done: '█', left: '░', over: '▓', now: '▒', sep: ' · ', bar: ' │ ', cut: '…' };
const ASCII = { done: '#', left: '.', over: '!', now: '>', sep: ' - ', bar: ' | ', cut: '...' };
// C0 and C1 controls, line and paragraph separators, and the invisible format characters (bidi marks, overrides and isolates,
// zero-width space, word joiner, BOM) that would reorder or hide neighbouring words of a row (review SEC-4); ZWNJ (U+200C) and
// ZWJ (U+200D) stay, since Persian words and emoji need them and they move nothing (review SEC-9)
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|[\p{Cf}--[\u200c\u200d]]/gv;
const NOT_ASCII = /[^ -~]/gu;
const COMBINING_MARKS = /\p{M}/gu;
/** The ASCII stand-ins of the characters the board's own texts use (separators, ellipsis, arrows, dashes, quotes, bar and tree marks). */
const ASCII_STAND_IN = {
  '·': '-', '•': '*', '●': '*', '…': '...', '↑': '^', '↓': 'v', '←': '<', '→': '>', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"',
  '”': '"', '█': '#', '▓': '#', '▒': '#', '░': '.', '│': '|', '├': '|', '└': '`', '▸': '>', '✓': 'ok', '⚠': '!', '×': 'x',
};
/** Any other non-ASCII character (Persian, emoji): `?` would read as a question or an unknown value, so a plain blank mark. */
const UNKNOWN_CHAR = '_';
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
 * @returns {{ columns: number, ascii: boolean, color: boolean, colors256: boolean, glyph: typeof UNICODE }} the look of every row
 *   drawn for this terminal; colors256: TERM or COLORTERM names 256 or true colour, or WT_SESSION is set (Windows Terminal, which
 *   sets neither of them); else the hues fall back to bold/underline/plain
 */
export function lookOf(env, platform, columns) {
  const ascii = wantsAscii(env, platform);
  const color = !env.NO_COLOR && env.TERM !== 'dumb';
  return { columns, ascii, color, colors256: color && (Boolean(env.WT_SESSION) || COLOR_TERM.test(`${env.TERM ?? ''} ${env.COLORTERM ?? ''}`)), glyph: ascii ? ASCII : UNICODE };
}

/** @returns {string} the state of identity hue `hue` (an index into HUE_CODES) */
export const hueState = (hue) => `hue:${hue}`;

/** The escape code of a state on this terminal; '' for ok, an unknown state, or no colour. */
function codeOf(state, look) {
  if (!look.color) return '';
  const hue = HUE_STATE.exec(state ?? '');
  if (hue === null) return COLOR_CODE[state] ?? '';
  const index = Number(hue[1]) % HUE_CODES.length;
  return look.colors256 ? `\u001b[38;5;${HUE_CODES[index]}m` : HUE_STYLES_16[(index + Math.floor(index / 3)) % 3];
}

/** @returns {string} the text in the colour of its state, bold when asked (no codes without colour, for ok, or an unknown state) */
export function paint(text, state, look, bold = false) {
  const code = codeOf(state, look);
  return code ? `${bold ? BOLD : ''}${code}${text}${RESET}` : text;
}

/** A part painted: each of its spans in its own state when it has spans, else the whole text in the part's state. */
const paintPart = (part, look) => (Array.isArray(part.spans)
  ? part.spans.map((span) => paint(span.text, span.state, look, part.bold)).join('')
  : paint(part.text, part.state, look, part.bold));

/**
 * @returns {string} a text from outside (input, files) with control characters gone and, in ASCII mode, every non-ASCII character
 *   as its stand-in: an accent dropped (`café` -> `cafe`), ASCII_STAND_IN, else UNKNOWN_CHAR; never `?` (review, fix round 7)
 */
export function cleanText(text, look) {
  const plain = String(text ?? '').replace(CONTROL_CHARS, ' ');
  if (!look.ascii) return plain;
  return plain.normalize('NFKD').replace(COMBINING_MARKS, '').replace(NOT_ASCII, (char) => ASCII_STAND_IN[char] ?? UNKNOWN_CHAR);
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

/** The first `keep` characters of a part's spans (the separator before it first), each in its own state. */
function paintSpansCut(spans, keep, look, bold) {
  let left = keep;
  return spans.map((span) => {
    const text = [...span.text].slice(0, left).join('');
    left -= widthOf(text);
    return text === '' ? '' : paint(text, span.state, look, bold);
  }).join('');
}

/** The parts joined, each painted; the last one that does not fit is cut and ends with the cut mark (a part with spans keeps its spans' states). */
function joined(parts, look) {
  let out = '';
  let used = 0;
  for (const [index, part] of parts.entries()) {
    const sep = index === 0 ? '' : sepOf(part, look);
    const piece = `${sep}${part.text}`;
    const room = look.columns - used;
    if (widthOf(piece) <= room) {
      out += `${sep}${paintPart(part, look)}`;
      used += widthOf(piece);
      continue;
    }
    const keep = Math.max(0, room - widthOf(look.glyph.cut));
    if (Array.isArray(part.spans) && room >= widthOf(look.glyph.cut)) {
      return `${out}${paintSpansCut([{ text: sep }, ...part.spans], keep, look, part.bold)}${look.glyph.cut}`;
    }
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
