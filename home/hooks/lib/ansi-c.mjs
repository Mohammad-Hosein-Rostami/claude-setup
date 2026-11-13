// Decoder for bash ANSI-C quoting: the text inside `$'...'`, so `$'\x72m'` is read as `rm`.
// Exports: decodeAnsiC(body) -> string; ANSI_C_WORD (regex source for a whole `$'...'` word part).
// Handles \a \b \e \E \f \n \r \t \v \\ \' \" \? , octal \NNN (1-3 digits), \xHH (1-2), \uHHHH (1-4), \UHHHHHHHH (1-8)
// and \cX. An unknown escape stays as typed (bash does the same); a NUL ends the string (bash does the same).
// Pure, no I/O. Invariant: linear in the body length; never throws.

/** Regex source for one `$'...'` word part: a backslash escapes the next character, so `\'` does not close it. */
export const ANSI_C_WORD = "\\$'(?:\\\\[\\s\\S]|[^'\\\\])*'";

const SIMPLE_ESCAPES = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
const NUMERIC_ESCAPES = [
  [/^[0-7]{1,3}/, 8, 0],
  [/^x[0-9a-fA-F]{1,2}/, 16, 1],
  [/^u[0-9a-fA-F]{1,4}/, 16, 1],
  [/^U[0-9a-fA-F]{1,8}/, 16, 1],
];
const MAX_CODE_POINT = 0x10ffff;

/** @returns {[string, number] | undefined} the decoded text and how many characters of `rest` it used, or undefined when `rest` is not a numeric escape */
function numericEscape(rest) {
  for (const [pattern, radix, skip] of NUMERIC_ESCAPES) {
    const match = pattern.exec(rest);
    if (!match) continue;
    const code = parseInt(match[0].slice(skip), radix);
    return [code > MAX_CODE_POINT ? match[0] : String.fromCodePoint(code % (radix === 8 ? 256 : MAX_CODE_POINT + 1)), match[0].length];
  }
  return undefined;
}

/**
 * @param {string} body text between `$'` and the closing `'` (escapes still in it)
 * @returns {string} what the shell passes on
 */
export function decodeAnsiC(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\' || i + 1 >= body.length) {
      out += body[i];
      continue;
    }
    const rest = body.slice(i + 1);
    const numeric = numericEscape(rest);
    if (numeric) {
      if (numeric[0] === '\0') return out;
      out += numeric[0];
      i += numeric[1];
    } else if (rest[0] === 'c' && rest.length > 1) {
      out += String.fromCharCode(rest.charCodeAt(1) & 0x1f);
      i += 2;
    } else if (rest[0] in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[rest[0]];
      i += 1;
    } else out += `\\${rest[0]}`, i += 1;
  }
  return out;
}
