// How a hook note shows a file name or a path that comes from a repository or a transcript (untrusted text).
// Exports: shownName(file), quotedName(file), shownPath(folder, file), quotedPath(folder, file), escaped(text),
// escapedEnd(text, maxChars). Run as a command (`node shown-name.mjs <text>`) it prints escaped(text).
// Why: the text sits inside a note the lead reads in the owner's voice, so it must never look like more of that note (security review
// p0-0.1, S5 and N4: look-alike slashes, invisible letters, tag-like text and a `\"` once reached the note unescaped).
// Invariants: pure. A name of SAFE_FILE_NAME (A-Z a-z 0-9 _ . -, at most 64 characters, then .md) is shown as it is, and so is a
// path whose folder is SAFE_FOLDER and whose file is such a name. Anything else is shown in double quotes, each part cut by code
// points (so never inside a surrogate pair or an escape) to at most NAME_SHOWN_CODE_POINTS code points and NAME_SHOWN_CHARS characters
// of escaped text, with `...` after a cut. Escaped text holds printable ASCII only; every other character, and also " \ < >, is one
// whole escape: \n \r \t, \uXXXX, or \u{XXXXX} above U+FFFF.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SAFE_FILE_NAME = /^[\w.-]{1,64}\.md$/;
const SAFE_FOLDER = /^(?:[\w.-]{1,64}\/){1,8}$/; // up to eight plain folder names, each followed by its slash
const NAME_SHOWN_CODE_POINTS = 64;
const BMP_ESCAPE_CHARS = '\\uXXXX'.length;
// 384: room for NAME_SHOWN_CODE_POINTS escaped characters up to U+FFFF. A braced escape is longer, so fewer of those are shown.
const NAME_SHOWN_CHARS = NAME_SHOWN_CODE_POINTS * BMP_ESCAPE_CHARS;
const CUT_MARK = '...';
const PLAIN_IN_QUOTES = /^[ !#-;=?-[\]-~]$/; // printable ASCII without " < > and \
const NAMED_ESCAPES = new Map([['\n', '\\n'], ['\r', '\\r'], ['\t', '\\t']]);
const LAST_BMP_CODE_POINT = 0xffff;
const HEX_RADIX = 16;
const BMP_HEX_DIGITS = 4;
const LEADING_LOW_SURROGATE = /^[\udc00-\udfff]/; // the second half of a pair a cut went through

/** One code point as escaped text shows it: itself when plain, else a whole escape. */
function escapeOf(char) {
  if (PLAIN_IN_QUOTES.test(char)) return char;
  if (NAMED_ESCAPES.has(char)) return NAMED_ESCAPES.get(char);
  const point = char.codePointAt(0);
  const hex = point.toString(HEX_RADIX);
  return point > LAST_BMP_CODE_POINT ? `\\u{${hex}}` : `\\u${hex.padStart(BMP_HEX_DIGITS, '0')}`;
}

/** The escaped start of `text`, cut to the shown length; it ends in `...` when it was cut. */
function escapedStart(text) {
  let shown = '';
  let points = 0;
  for (const char of text) {
    const next = escapeOf(char);
    if (points === NAME_SHOWN_CODE_POINTS || shown.length + next.length > NAME_SHOWN_CHARS) return `${shown}${CUT_MARK}`;
    shown += next;
    points += 1;
  }
  return shown;
}

/**
 * Text with everything outside plain printable ASCII, and also " \ < >, escaped; not cut.
 * @param {string} text - untrusted text of a known small size (a folder path).
 * @returns {string} the escaped text, printable ASCII only.
 */
export function escaped(text) {
  return Array.from(text, escapeOf).join('');
}

/**
 * The escaped end of a text, at most `maxChars` long: a long path is cut from the left, since its end names the file.
 * @param {string} text - untrusted text of any length (only its last `maxChars` characters are looked at).
 * @param {number} maxChars - the longest result, in characters of escaped text; at least the cut mark.
 * @returns {string} the whole escaped text when it fits; else `...` and as many whole escaped characters of its end as fit.
 */
export function escapedEnd(text, maxChars) {
  const tail = text.slice(-maxChars).replace(LEADING_LOW_SURROGATE, '');
  const escapes = Array.from(tail, escapeOf);
  const whole = escapes.join('');
  if (tail.length === text.length && whole.length <= maxChars) return whole;
  let from = escapes.length;
  for (let room = maxChars - CUT_MARK.length; from > 0 && escapes[from - 1].length <= room; from -= 1) room -= escapes[from - 1].length;
  return `${CUT_MARK}${escapes.slice(from).join('')}`;
}

/**
 * A file name in double quotes with everything outside plain printable ASCII escaped, cut to the shown length.
 * @param {string} file - the file name (untrusted).
 * @returns {string} the quoted name; it ends in `..."` when the name was cut.
 */
export function quotedName(file) {
  return `"${escapedStart(file)}"`;
}

/**
 * A file name as a note shows it: as it is when plain, else quoted and escaped.
 * @param {string} file - the file name (untrusted).
 * @returns {string} the name to print.
 */
export function shownName(file) {
  return SAFE_FILE_NAME.test(file) ? file : quotedName(file);
}

/**
 * A path in double quotes, escaped like a quoted name; the folder and the name are each cut to the shown length.
 * @param {string} folder - the folder part, ending in `/` (its subfolder names are untrusted).
 * @param {string} name - the last part: a file or folder name (untrusted).
 * @returns {string} the quoted path.
 */
export function quotedPath(folder, name) {
  return `"${escapedStart(folder)}${escapedStart(name)}"`;
}

/**
 * A path as a note shows it: as it is when the folder and the file name are plain, else quoted and escaped.
 * @param {string} folder - the folder part, ending in `/`.
 * @param {string} file - the file name.
 * @returns {string} the path to print.
 */
export function shownPath(folder, file) {
  return SAFE_FOLDER.test(folder) && SAFE_FILE_NAME.test(file) ? `${folder}${file}` : quotedPath(folder, file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) console.log(escaped(process.argv[2] ?? ''));
