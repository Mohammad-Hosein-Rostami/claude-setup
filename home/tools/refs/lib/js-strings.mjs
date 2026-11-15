// Purpose: list the string literals of a JavaScript, TypeScript or JSON file with their line, skipping comments,
//   regular expression literals and the inside of template-literal substitutions. It is not a parser: it only needs
//   to know where a string starts and ends.
// Exports: stringLiterals.
// Invariants: returns {value, line} in file order. A template literal with `${` is returned with its raw text, so a
//   reader can skip it; an unterminated string ends at the end of its line, so one bad quote cannot swallow the file.
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

function endOfString(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length && text[index] !== quote) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === '\n' && quote !== '`') return index;
    index += 1;
  }
  return index;
}

function endOfRegex(text, start) {
  let inClass = false;
  for (let index = start + 1; index < text.length && text[index] !== '\n'; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === '[') inClass = true;
    else if (text[index] === ']') inClass = false;
    else if (text[index] === '/' && !inClass) return index;
  }
  return start; // not a regex after all: treat the slash as an operator
}

function skipComment(text, index) {
  if (text[index + 1] === '/') {
    const end = text.indexOf('\n', index);
    return end === -1 ? text.length : end - 1; // stop before the newline so the caller counts it
  }
  const end = text.indexOf('*/', index + 2);
  return end === -1 ? text.length : end + 1;
}

/**
 * @param {string} text file content
 * @returns {{value: string, line: number}[]}
 */
export function stringLiterals(text) {
  const found = [];
  let line = 1;
  let previous = ''; // last significant character, to tell a regex from a division
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') line += 1;
    if (char === '"' || char === "'" || char === '`') {
      const end = endOfString(text, index);
      found.push({ value: text.slice(index + 1, end), line });
      line += text.slice(index, end).split('\n').length - 1;
      index = text[end] === '\n' ? end - 1 : end; // an unterminated string stops before its newline
      previous = char;
    } else if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      const end = skipComment(text, index);
      line += text.slice(index, end).split('\n').length - 1;
      index = end;
    } else if (char === '/' && REGEX_PRECEDERS.has(previous) && endOfRegex(text, index) > index) {
      index = endOfRegex(text, index);
      previous = '/';
    } else if (!/\s/.test(char)) previous = char;
  }
  return found;
}
