// Bash brace expansion for one word: `{a,b}`, nested `x{a,{b,c}}y`, numeric and letter ranges `{1..3}` `{a..c}`.
// Exports: expandBraces(word) -> string[] | null. Pure, never evaluates anything.
// A word without a real brace expression (`{}`, `{a}`, unbalanced braces) comes back unchanged. null means the word has one that
// cannot be listed (a range that is not plain numbers/letters, or more than MAX_EXPANSIONS results): the caller treats it as unknown.

const MAX_EXPANSIONS = 256;

/** Index of the `}` matching the `{` at `open`, or -1. A backslash escapes the next character. */
function closingBrace(word, open) {
  let depth = 0;
  for (let i = open; i < word.length; i++) {
    if (word[i] === '\\') i++;
    else if (word[i] === '{') depth++;
    else if (word[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Splits the text between braces at its top-level commas. */
function alternatives(body) {
  const parts = [''];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') parts[parts.length - 1] += c + (body[++i] ?? '');
    else if (c === ',' && depth === 0) parts.push('');
    else {
      if (c === '{') depth++;
      if (c === '}') depth--;
      parts[parts.length - 1] += c;
    }
  }
  return parts;
}

/** `1..3` / `a..e` -> the listed values, null when it is a range we cannot list, undefined when the body is not a range. */
function rangeValues(body) {
  const m = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/.exec(body);
  if (!m) return /^[^,]*\.\.[^,]*$/.test(body) ? null : undefined;
  const numeric = /\d/.test(m[1]);
  if (numeric !== /\d/.test(m[2])) return null; // `{a..3}` mixes kinds
  const [from, to] = numeric ? [Number(m[1]), Number(m[2])] : [m[1].charCodeAt(0), m[2].charCodeAt(0)];
  const step = Math.abs(Number(m[3] ?? 1)) || 1;
  if (Math.abs(to - from) / step >= MAX_EXPANSIONS) return null;
  const width = numeric && /^-?0\d/.test(m[1] + m[2]) ? Math.max(m[1].length, m[2].length) : 0; // `{01..10}` pads every value to the same width
  const values = [];
  for (let v = from; from <= to ? v <= to : v >= to; v += from <= to ? step : -step) {
    values.push(numeric ? (v < 0 ? '-' : '') + String(Math.abs(v)).padStart(width - (v < 0 ? 1 : 0), '0') : String.fromCharCode(v));
  }
  return values;
}

/**
 * @param {string} word one unquoted word
 * @returns {string[] | null} every word the shell would make of it, or null when the expansion cannot be listed
 */
export function expandBraces(word) {
  for (let open = word.indexOf('{'); open !== -1; open = word.indexOf('{', open + 1)) {
    if (word[open - 1] === '\\' || word[open - 1] === '$') continue; // `${VAR}` is a parameter, not a brace expression
    const close = closingBrace(word, open);
    if (close === -1) continue;
    const body = word.slice(open + 1, close);
    const range = rangeValues(body);
    const options = range === undefined ? alternatives(body) : range;
    if (options === null) return null;
    if (options.length < 2) continue; // `{}` and `{a}` stay as they are
    const results = [];
    for (const option of options) {
      const tails = expandBraces(word.slice(0, open) + option + word.slice(close + 1));
      if (tails === null) return null;
      results.push(...tails);
      if (results.length > MAX_EXPANSIONS) return null;
    }
    return results;
  }
  return [word];
}
