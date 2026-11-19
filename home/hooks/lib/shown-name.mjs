// How a hook note shows a file name that comes from a repository (untrusted text). Exports: shownName(file), quotedName(file).
// Why: the name sits inside a note the lead reads in the owner's voice, so it must never look like more of that note (security review
// p0-0.1, S5 and N4: look-alike slashes, invisible letters, tag-like text and a `\"` once reached the note unescaped).
// Invariants: pure. A name of SAFE_FILE_NAME (A-Z a-z 0-9 _ . -, at most 64 characters, then .md) is shown as it is. Any other name is
// shown in double quotes, cut by code points (so never inside a surrogate pair or an escape) to at most NAME_SHOWN_CODE_POINTS code
// points and NAME_SHOWN_CHARS characters of escaped text, with `...` after a cut. Inside the quotes only printable ASCII stays as it
// is; every other character, and also " \ < >, is one whole escape: \n \r \t, \uXXXX, or \u{XXXXX} above U+FFFF.
const SAFE_FILE_NAME = /^[\w.-]{1,64}\.md$/;
const NAME_SHOWN_CODE_POINTS = 64;
const BMP_ESCAPE_CHARS = '\\uXXXX'.length;
// 384: room for NAME_SHOWN_CODE_POINTS escaped characters up to U+FFFF. A braced escape is longer, so fewer of those are shown.
const NAME_SHOWN_CHARS = NAME_SHOWN_CODE_POINTS * BMP_ESCAPE_CHARS;
const PLAIN_IN_QUOTES = /^[ !#-;=?-[\]-~]$/; // printable ASCII without " < > and \
const NAMED_ESCAPES = new Map([['\n', '\\n'], ['\r', '\\r'], ['\t', '\\t']]);
const LAST_BMP_CODE_POINT = 0xffff;
const HEX_RADIX = 16;
const BMP_HEX_DIGITS = 4;

/** One code point as the quoted name shows it: itself when plain, else a whole escape. */
function escapeOf(char) {
  if (PLAIN_IN_QUOTES.test(char)) return char;
  if (NAMED_ESCAPES.has(char)) return NAMED_ESCAPES.get(char);
  const point = char.codePointAt(0);
  const hex = point.toString(HEX_RADIX);
  return point > LAST_BMP_CODE_POINT ? `\\u{${hex}}` : `\\u${hex.padStart(BMP_HEX_DIGITS, '0')}`;
}

/**
 * A file name in double quotes with everything outside plain printable ASCII escaped, cut to the shown length.
 * @param {string} file - the file name (untrusted).
 * @returns {string} the quoted name; it ends in `..."` when the name was cut.
 */
export function quotedName(file) {
  let shown = '';
  let points = 0;
  for (const char of file) {
    const next = escapeOf(char);
    if (points === NAME_SHOWN_CODE_POINTS || shown.length + next.length > NAME_SHOWN_CHARS) return `"${shown}..."`;
    shown += next;
    points += 1;
  }
  return `"${shown}"`;
}

/**
 * A file name as a note shows it: as it is when plain, else quoted and escaped.
 * @param {string} file - the file name (untrusted).
 * @returns {string} the name to print.
 */
export function shownName(file) {
  return SAFE_FILE_NAME.test(file) ? file : quotedName(file);
}
