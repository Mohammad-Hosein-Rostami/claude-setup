// Bash brace expansion for one word: `{a,b}`, nested `x{a,{b,c}}y`, numeric and letter ranges `{1..3}` `{a..c}`.
// Exports: expandBraces(word) -> string[] | null for an unquoted word (rm targets); expandRawBraces(raw) -> string[] | null for a word as
// written, whose quoted parts are text (`"{a,b}"` stays one word); hasUnquotedReference(raw) (a `$NAME` outside quotes, which bash splits).
// A word without a real brace expression (`{}`, `{a}`, unbalanced braces, `${VAR}`) comes back unchanged. null means the word has one
// the guard cannot list: more than MAX_EXPANSIONS results, braces nested deeper than MAX_BRACE_NESTING, a range that is not plain
// numbers or letters, and for a raw word an alternative with `$` or a backtick (what it becomes is only known when it runs) or a brace
// expression inside `${...}` (zsh expands it there). The caller treats such a word as unreadable.
// Pure, never evaluates anything; the work is linear in the word length times the nesting cap.

const MAX_EXPANSIONS = 64; // words one word may expand to; more cannot be listed
const MAX_BRACE_NESTING = 8; // braces inside braces; deeper cannot be listed
const RUNS_AT_EXPANSION = /[$`]/; // a parameter, command substitution or backtick: its text is only known when it runs
const INNER_BRACE_EXPRESSION = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

/** Raw mode: the index after the quoted text or escape that starts at `i` (`'..'`, `".."`, `$'..'`, `\x`), or `i` when none starts there. */
function afterQuoted(word, i) {
  const c = word[i];
  if (c === '\\') return i + 2;
  if (c === "'") return word.includes("'", i + 1) ? word.indexOf("'", i + 1) + 1 : word.length;
  const closer = c === '"' ? '"' : c === '$' && word[i + 1] === "'" ? "'" : undefined;
  if (closer === undefined) return i;
  for (let j = i + (closer === "'" ? 2 : 1); j < word.length; j++) {
    if (word[j] === '\\') j++;
    else if (word[j] === closer) return j + 1;
  }
  return word.length;
}

/** The index after what starts at `i` that is never brace syntax: quoted text in raw mode, an escape always; `i` when nothing is skipped. */
const skipped = (word, i, raw) => (raw ? afterQuoted(word, i) : word[i] === '\\' ? i + 2 : i);

/** `{` index -> the index of its matching `}`, for every `{` that has one; quoted text (raw mode) and escapes are skipped. One pass. */
function braceMatches(word, raw) {
  const matches = new Map();
  const open = [];
  for (let i = 0; i < word.length; i++) {
    const next = skipped(word, i, raw);
    if (next !== i) i = next - 1;
    else if (word[i] === '{') open.push(i);
    else if (word[i] === '}' && open.length > 0) matches.set(open.pop(), i);
  }
  return matches;
}

/** Splits the text between braces at its top-level commas (quoted commas are text in raw mode). */
function alternatives(body, raw) {
  const parts = [''];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const next = skipped(body, i, raw);
    if (next !== i) {
      parts[parts.length - 1] += body.slice(i, next);
      i = next - 1;
    } else if (body[i] === ',' && depth === 0) parts.push('');
    else {
      if (body[i] === '{') depth++;
      if (body[i] === '}') depth--;
      parts[parts.length - 1] += body[i];
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

/** Raw mode: true when an alternative's text is known before it runs (no `$` or backtick outside single quotes and escapes). */
function isPlain(option) {
  let text = '';
  for (let i = 0; i < option.length; i++) {
    const next = option[i] === "'" || option[i] === '\\' ? afterQuoted(option, i) : i;
    if (next === i) text += option[i];
    else i = next - 1;
  }
  return !RUNS_AT_EXPANSION.test(text);
}

/** Every word `word` expands to, left to right as bash lists them; null when it cannot be listed (see the header). */
function expand(word, raw, depth) {
  if (depth > MAX_BRACE_NESTING) return null;
  const closing = braceMatches(word, raw);
  let results = [''];
  let start = 0; // where the literal text before the next brace expression begins
  for (let i = 0; i < word.length; i++) {
    const next = skipped(word, i, raw);
    if (next !== i) {
      i = next - 1;
      continue;
    }
    const parameter = word[i] === '$' && word[i + 1] === '{';
    if (word[i + (parameter ? 1 : 0)] !== '{') continue;
    const close = closing.get(i + (parameter ? 1 : 0)) ?? -1;
    if (close === -1) continue;
    if (parameter && raw && INNER_BRACE_EXPRESSION.test(word.slice(i + 2, close))) return null;
    if (parameter) {
      i = close; // `${...}` is a parameter, not a brace expression
      continue;
    }
    const body = word.slice(i + 1, close);
    const range = rangeValues(body);
    const options = range === undefined ? alternatives(body, raw) : range;
    if (options === null || (raw && !options.every(isPlain))) return null;
    if (options.length < 2) continue; // `{}` and `{a}` stay as they are; a brace expression inside them still expands
    const listed = [];
    for (const option of options) {
      const inner = expand(option, raw, depth + 1);
      if (inner === null || listed.push(...inner) > MAX_EXPANSIONS) return null;
    }
    const literal = word.slice(start, i);
    results = results.flatMap((before) => listed.map((option) => before + literal + option));
    if (results.length > MAX_EXPANSIONS) return null;
    start = close + 1;
    i = close;
  }
  return results.map((before) => before + word.slice(start));
}

/**
 * @param {string} word one unquoted word
 * @returns {string[] | null} every word the shell would make of it, or null when the expansion cannot be listed
 */
export const expandBraces = (word) => expand(word, false, 0);

/**
 * @param {string} raw one word as written, quotes and escapes intact
 * @returns {string[] | null} the raw words bash makes of it (quotes still in them), or null when the guard cannot list them
 */
export const expandRawBraces = (raw) => (raw.includes('{') ? expand(raw, true, 0) : [raw]);

/**
 * @param {string} raw one word as written
 * @returns {boolean} true when a `$NAME` or `${NAME}` stands outside quotes: bash splits its value into words at blanks
 */
export function hasUnquotedReference(raw) {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '$' && /[A-Za-z_{]/.test(raw[i + 1] ?? '')) return true;
    const next = afterQuoted(raw, i);
    if (next !== i) i = next - 1;
  }
  return false;
}
