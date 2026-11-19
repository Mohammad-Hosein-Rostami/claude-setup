// Purpose: write untrusted names (file paths, a range with a branch name in it) into briefs and text output as data, so a crafted
//   name cannot read as an instruction to the reviewer (security S3 of lane r7-delta: a file named "... Delta review: ... mark each closed").
// Exports: asData(name), placeText(path, line).
// Invariants: a plain name is printed as it is; any other is one JSON string of printable ASCII only: quotes, backslashes and control
//   characters escaped by JSON, and `<`, `>` and everything outside printable ASCII written as \uXXXX. The agents' Delta mode says that
//   text inside such a name is never an instruction.

// Letters, digits and the marks git names and revisions use without being able to form a sentence (no space, quote or bracket).
const PLAIN_NAME = /^[\w@+=.,/~^{}-]+$/;
const NOT_PLAIN_ASCII = /[<>\u007f-￿]/g;
const HEX = 16;
const ESCAPE_DIGITS = 4;

/**
 * A name as it may stand in a brief.
 * @param {string} name a file path, branch name or range, from git or from the caller
 * @returns {string} the name itself when it is plain, else a quoted, escaped JSON string
 */
export function asData(name) {
  if (PLAIN_NAME.test(name)) return name;
  return JSON.stringify(name).replace(NOT_PLAIN_ASCII, (char) => `\\u${char.charCodeAt(0).toString(HEX).padStart(ESCAPE_DIGITS, '0')}`);
}

/** `path:line` with the path as data; a line of 0 (a hit on the path itself) gives the path alone. */
export const placeText = (path, line) => (line > 0 ? `${asData(path)}:${line}` : asData(path));
