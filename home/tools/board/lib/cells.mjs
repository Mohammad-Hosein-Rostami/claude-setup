// The cells every progress surface draws with (display design 4.1): the look of the terminal (glyphs, separators, colour), bars,
// durations, clocks, row labels, and fitting a row of parts to a width. Used by render.mjs (the status line rows).
// Exports: lookOf(env, platform, columns) -> look; paint(text, state, look, bold); cleanText(text, look); cutWords(text, max, look);
// fitParts(parts, look) -> string; partsWidth(parts, look); barText(shares, cells, look); durationText(minutes);
// clockOf(ms, nowMs, timeZone); labelled(label, part, look); STATE; DONE_SHOWN_MS; WIDE_COLUMNS, LABEL_FROM_COLUMNS, LABEL_COLUMNS.
// Colour by kind (owner decision RC14, 2026-11-22: "dont over do"; spec R18 colour table): four kinds have their own colour, each
// meaning that kind only: `branch` (a git branch name), `bar` (a progress bar and its count), `time` (work left, finish and reset
// clocks), `session` (model, effort, context, limit values). Three states are reserved and basic ANSI so the terminal theme maps
// them: `warn` yellow (needs a look), `block` red (a problem), `wait` magenta (needs you). `dim` (SGR 2) is for labels, ages and
// the ` · ` between parts; `strong` is bold with no colour (a repository name). `run` (working, `/where` callers only) takes the
// bar's colour; `ok`, `done` and `road` paint nothing: counts and words are in the default colour. A part's `bold` makes it bold.
// A part may carry `spans` (texts in order whose join is its text, each with its own state).
// Palette (lookOf): `none` without colour; 256 colours (`dark`, or `light` when CLAUDE_STATUS_THEME=light or COLORFGBG's last
// field is 7 or 15; CLAUDE_STATUS_THEME=dark forces dark) when TERM has `256color` or COLORTERM is `truecolor` or `24bit`; else
// `16`, the basic codes of the same kinds (owner decision RC20).
// Look: ASCII when CLAUDE_STATUS_ASCII=1, TERM=dumb, Windows without WT_SESSION and TERM_PROGRAM (the old console host), or a locale
// that is set and not UTF-8; colour off when NO_COLOR is set to any non-empty value (no-color.org), TERM=dumb or on that old console.
// Invariants: pure (no I/O); every state also has a word in the text (colour is never the only signal); in ASCII mode no byte
// above 0x7E is ever returned, since every outside text goes through cleanText; a fitted row is never wider than `columns`.
import { clockText, dayText, localDate } from './local-clock.mjs';

/** From this usable width the rows take their long words: a 120-column terminal gives 115 (COLUMNS - 5, research-tui 1.1). */
export const WIDE_COLUMNS = 115;
/** From this usable width every row leads with a LABEL_COLUMNS-wide dim label (100 columns give 95); below it the label and a blank. */
export const LABEL_FROM_COLUMNS = 90;
export const LABEL_COLUMNS = 8;

/** The kinds and states a part may carry: four kinds with their own colour, three reserved states, dim and strong, and the plain ones. */
export const STATE = {
  ok: 'ok', done: 'done', run: 'run', warn: 'warn', block: 'block', wait: 'wait', dim: 'dim', road: 'road', strong: 'strong',
  branch: 'branch', bar: 'bar', time: 'time', session: 'session',
};
/** The SGR codes of the four kinds per palette (spec R18 colour table: contrast 4.36 to 6.45 on #1e1e1e and #fff). */
const KIND_CODES = {
  dark: { branch: '38;5;35', bar: '38;5;37', time: '38;5;33', session: '38;5;103' },
  light: { branch: '38;5;28', bar: '38;5;30', time: '38;5;25', session: '38;5;60' },
  16: { branch: '32', bar: '36', time: '34', session: '37' },
};
/** The reserved states, the same on every palette: the terminal theme maps them on dark and light backgrounds. */
const RESERVED_CODES = { warn: '33', block: '31', wait: '35', dim: '2', strong: '1' };
const PALETTE = { dark: 'dark', light: 'light', basic: '16', none: 'none' };
const TRUE_COLOR = /^(truecolor|24bit)$/i;
const LIGHT_BACKGROUNDS = new Set(['7', '15']); // COLORFGBG's background field of a light theme (rxvt, Konsole, iTerm2)
/** A finished agent keeps its row this long. */
export const DONE_SHOWN_MS = 30_000;
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
const HOURS_FROM_MIN = MIN_PER_HOUR; // spec R18 mockups: `1 h 30 work left`, `1 h 10 late`, not `90 min`
const MS_PER_MIN = 60_000;

/** True on the old Windows console host (no Windows Terminal, no other terminal program): plain ASCII, no escape codes (R18 F1). */
const oldWindowsConsole = (env, platform) => platform === 'win32' && !env.WT_SESSION && !env.TERM_PROGRAM;

/** True when the terminal cannot be trusted with the Unicode cells (design 4.1). */
function wantsAscii(env, platform) {
  if (env.CLAUDE_STATUS_ASCII === '1' || env.TERM === 'dumb') return true;
  if (oldWindowsConsole(env, platform)) return true;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return Boolean(locale) && !UTF8_LOCALE.test(locale);
}

/** The palette of a colour terminal: 256 colours (dark or light background) when it says so, else the basic 16. */
function paletteOf(env) {
  const has256 = String(env.TERM ?? '').includes('256color') || TRUE_COLOR.test(String(env.COLORTERM ?? ''));
  if (!has256) return PALETTE.basic;
  const theme = String(env.CLAUDE_STATUS_THEME ?? '').toLowerCase();
  if (theme === PALETTE.light || theme === PALETTE.dark) return theme;
  return LIGHT_BACKGROUNDS.has(String(env.COLORFGBG ?? '').split(';').at(-1)) ? PALETTE.light : PALETTE.dark;
}

/**
 * @param {Record<string, string | undefined>} env the process environment
 * @param {string} platform process.platform
 * @param {number} columns the width rows are fitted to
 * @returns {{ columns: number, ascii: boolean, color: boolean, glyph: typeof UNICODE, palette: 'dark' | 'light' | '16' | 'none' }}
 *   the look of every row drawn for this terminal
 */
export function lookOf(env, platform, columns) {
  const ascii = wantsAscii(env, platform);
  const color = !env.NO_COLOR && env.TERM !== 'dumb' && !oldWindowsConsole(env, platform);
  return { columns, ascii, color, glyph: ascii ? ASCII : UNICODE, palette: color ? paletteOf(env) : PALETTE.none };
}

/** The SGR code of a state on this terminal's palette ('16' for a look made without one); '' for a plain state or no colour. */
function sgrOf(state, look) {
  if (!look.color) return '';
  const kinds = KIND_CODES[look.palette] ?? KIND_CODES[PALETTE.basic];
  return RESERVED_CODES[state] ?? kinds[state === STATE.run ? STATE.bar : state] ?? '';
}

/** The escape code of a state on this terminal; '' for ok, an unknown state, or no colour. */
const codeOf = (state, look) => { const sgr = sgrOf(state, look); return sgr ? `\u001b[${sgr}m` : ''; };

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

/** The state of the text before a part: dim for the ` · ` and ` │ ` marks (spec R18: separators are secondary), plain for a `join`. */
const sepState = (sep, look) => (sep === look.glyph.sep || sep === look.glyph.bar ? STATE.dim : STATE.ok);

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
      out += `${paint(sep, sepState(sep, look), look)}${paintPart(part, look)}`;
      used += widthOf(piece);
      continue;
    }
    const keep = Math.max(0, room - widthOf(look.glyph.cut));
    if (Array.isArray(part.spans) && room >= widthOf(look.glyph.cut)) {
      return `${out}${paintSpansCut([{ text: sep, state: sepState(sep, look) }, ...part.spans], keep, look, part.bold)}${look.glyph.cut}`;
    }
    return `${out}${paint(`${[...piece].slice(0, keep).join('')}${look.glyph.cut}`.slice(0, Math.max(0, room)), part.state, look, part.bold)}`;
  }
  return out;
}

/** The fewest blanks between the left parts and the right-aligned block of a row. */
const RIGHT_GAP = 2;
/** Below this many columns for the left parts the row is not split: its parts run on and the end is cut. */
const MIN_LEFT_COLUMNS = 8;
const ESCAPE_CODES = /\u001b\[[0-9;]*m/g;
const shownWidth = (text) => widthOf(text.replace(ESCAPE_CODES, ''));

/** The width of parts joined in order (the first one has no separator before it). */
const joinedWidth = (list, look) => list.reduce((sum, part, index) => sum + widthOf(part.text) + (index === 0 ? 0 : widthOf(sepOf(part, look))), 0);

/**
 * @param {{ text: string, bar?: boolean, join?: string }[]} parts the parts of a row, all shown, in order
 * @param {ReturnType<typeof lookOf>} look the terminal (its separators)
 * @returns {number} the visible width of the parts joined (the first one has no separator before it)
 */
export const partsWidth = (parts, look) => joinedWidth(parts.filter((part) => part.text !== ''), look);

/** The width of a row: its left parts, and its right block after RIGHT_GAP when it has one. */
function rowWidth(list, look) {
  const right = list.filter((part) => part.right);
  const left = joinedWidth(list.filter((part) => !part.right), look);
  return right.length === 0 ? left : left + RIGHT_GAP + joinedWidth(right, look);
}

/** The left parts, blanks, then the right block ending at look.columns; the left parts are cut when the row is too wide. */
function alignedRight(shown, look) {
  const right = joined(shown.filter((part) => part.right), look);
  const leftColumns = look.columns - shownWidth(right) - RIGHT_GAP;
  if (leftColumns < MIN_LEFT_COLUMNS) return joined(shown, look);
  const left = joined(shown.filter((part) => !part.right), { ...look, columns: leftColumns });
  return `${left}${' '.repeat(look.columns - shownWidth(left) - shownWidth(right))}${right}`;
}

/**
 * One row from its parts, fitted to look.columns: the parts with `drop` 0 always, then each level of `drop` in turn (1 first), a part
 * kept only when it still fits, so a low-priority short part can fill room a longer one left; whatever still overflows is cut.
 * @param {{ text: string, state?: string, drop?: number, bar?: boolean, join?: string, bold?: boolean, right?: true }[]} parts in
 *   display order; `bar` puts ` │ ` before the part, `join` another text in place of ` · `, `bold` makes it bold; the parts with
 *   `right` (the last ones) form a block that ends at look.columns, at least RIGHT_GAP blanks after the others
 * @param {ReturnType<typeof lookOf>} look the terminal
 * @returns {string} the row, at most look.columns visible characters
 */
export function fitParts(parts, look) {
  const present = parts.filter((part) => part.text !== '');
  const levels = [...new Set(present.map((part) => part.drop ?? 0))].filter((level) => level > 0).sort((a, b) => a - b);
  let kept = new Set(present.filter((part) => (part.drop ?? 0) === 0));
  for (const level of levels) {
    for (const part of present.filter((candidate) => candidate.drop === level)) {
      const trial = new Set([...kept, part]);
      if (rowWidth(present.filter((item) => trial.has(item)), look) <= look.columns) kept = trial;
    }
  }
  const shown = present.filter((part) => kept.has(part));
  return shown.some((part) => part.right) ? alignedRight(shown, look) : joined(shown, look);
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

/** @returns {string} `40 min` below 1 h, `2 h 05` below 10 h, then `14 h` (design 4.1, spec R18) */
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

/** The label column a row starts with: LABEL_COLUMNS wide from LABEL_FROM_COLUMNS, else the label and a blank. */
const labelHead = (label, look) => (look.columns >= LABEL_FROM_COLUMNS ? label.padEnd(LABEL_COLUMNS) : `${label} `);

/**
 * A row's first part with its dim label before it.
 * @param {string} label `agents`, `git`, `lanes` or `session`
 * @param {{ text: string, state?: string, drop?: number, spans?: object[] }} part the row's first value
 * @param {ReturnType<typeof lookOf>} look the terminal (the label column from LABEL_FROM_COLUMNS)
 * @returns {object} the part with the label before it, its value keeping its own spans or state
 */
export function labelled(label, part, look) {
  const head = labelHead(label, look);
  const value = Array.isArray(part.spans) ? part.spans : [{ text: part.text, state: part.state }];
  return { ...part, text: `${head}${part.text}`, spans: [{ text: head, state: STATE.dim }, ...value] };
}
