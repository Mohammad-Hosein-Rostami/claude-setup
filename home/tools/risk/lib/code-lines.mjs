// Tells which lines of a JavaScript or TypeScript text hold code, so a change that only touches comments or blank lines can be told apart
// from a change to code (done-check risk classes, design 3.6).
// Exports: linesWithCode(text) -> Set<number> (1-based line numbers).
// Invariants: pure, reads nothing. A line has code when any character outside a comment sits on it, a string or template literal included.
//   When the scan cannot be trusted (a block comment that never closes, as a regex like /[/*]/ can cause) every line counts as code, so a
//   doubt never hides a code change.

const NEWLINE = '\n';
const BACKTICK = '`';
const QUOTES = new Set(["'", '"']);

/** Leaves a string or template literal at its closing character; a backslash skips the next character (and counts a line it skips). */
function stringStep(text, at, state, onLine) {
  if (text[at] === '\\') {
    if (text[at + 1] === NEWLINE) onLine();
    return { at: at + 1, state };
  }
  return { at, state: text[at] === state ? 'code' : state };
}

/**
 * The lines of `text` that hold code.
 * @param {string} text file content
 * @returns {Set<number>} 1-based line numbers with at least one character of code (comment-only and blank lines are left out)
 */
export function linesWithCode(text) {
  const withCode = new Set();
  let line = 1;
  let state = 'code'; // code | line | block | a quote character | the backtick (a string or template literal ends at the same character)
  const nextLine = () => { line += 1; withCode.add(line); };
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    const pair = char + (text[at + 1] ?? '');
    if (char === NEWLINE) {
      line += 1;
      if (state === 'line' || QUOTES.has(state)) state = 'code'; // a ' or " string ends with its line
      else if (state === BACKTICK) withCode.add(line);
    } else if (state === 'block') {
      if (pair === '*/') { state = 'code'; at += 1; }
    } else if (state === 'line') {
      continue;
    } else if (state === 'code') {
      if (pair === '//') state = 'line';
      else if (pair === '/*') { state = 'block'; at += 1; }
      else if (!/\s/.test(char)) {
        withCode.add(line);
        if (QUOTES.has(char) || char === BACKTICK) state = char;
      }
    } else {
      withCode.add(line); // inside a string or a template literal
      ({ at, state } = stringStep(text, at, state, nextLine));
    }
  }
  if (state === 'block') return new Set(Array.from({ length: line }, (_, index) => index + 1));
  return withCode;
}
