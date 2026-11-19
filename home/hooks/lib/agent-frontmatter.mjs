// The frontmatter of an agent file, found the way Claude Code finds it, and the tolerant matches the project-agents note decides with.
// Exports: frontmatterOf(head), maxTurnsIn(frontmatter), hasToken(text, token).
// The rules were read from the Claude Code 2.1.328 bundle (security review p0-0.1, S3); re-read them when the CLI changes its parser:
//   function fR(e){return e.charCodeAt(0)===65279?e.slice(1):e}    a leading BOM is dropped
//   KI=/^---\s*\n([\s\S]*?)---\s*\n?/                              any whitespace after the opening ---, then a line end; the
//                                                                   frontmatter ends at the first --- after it, wherever that stands
// The CLI parses that text as YAML. This file does not parse YAML: it looks for a `maxTurns` key and for whole names anywhere in the
// text, so quoted keys, `name :`, a flow mapping, a folded scalar and a value on the next line are all seen. It may report a file the
// CLI would not (a name that only stands in the description); it must never miss one the CLI loads.
// Invariants: pure; linear time in the text. The CLI's own regex is not run: its `\s*\n` backtracks over a long run of line ends, which
// measured 0.6 s for 200 heads of 8 KiB of line ends (the SessionStart hook has 5 s in all) against under 1 ms here.
// Known limit: text that YAML decodes to another spelling (a "runner" escape, an alias) is not seen.
const BYTE_ORDER_MARK = 0xfeff;
const FENCE = '---';
const OPENING = /^---\s*/;
const MAX_TURNS_KEY = /(?<![\w-])maxTurns["']?\s*:/; // the key as a whole word, quoted or not, with any whitespace before its colon
const TURNS_NUMBER = /^\s*["']?(\d{1,6})["']?(?=[\s,}\]]|$)/; // a value of one to six digits and nothing glued to it
const NAME_CHAR = /[\w-]/; // a character that makes a longer name out of a match: `runner-2` is not `runner`

/**
 * The frontmatter text of an agent file, by Claude Code's own rules.
 * @param {string} head - the start of the file (the caller reads a capped head, so the closing --- may be missing).
 * @returns {string} the text between the opening --- line and the first --- after it; up to the end of `head` when no --- follows
 *   (the head was cut, or the file has no closing: matched anyway, which can only report more); '' when there is no opening.
 */
export function frontmatterOf(head) {
  const text = head.charCodeAt(0) === BYTE_ORDER_MARK ? head.slice(1) : head;
  const opening = text.match(OPENING)?.[0];
  if (!opening?.includes('\n')) return '';
  const end = text.indexOf(FENCE, opening.length);
  return end < 0 ? text.slice(opening.length) : text.slice(opening.length, end);
}

/**
 * What the note says about a maxTurns key in a frontmatter.
 * @param {string} frontmatter - the text from frontmatterOf.
 * @returns {string} '' without the key; `maxTurns <n>` for a number of at most six digits; else `maxTurns set`, so that nothing else
 *   of the value (untrusted text) reaches the note.
 */
export function maxTurnsIn(frontmatter) {
  const key = MAX_TURNS_KEY.exec(frontmatter);
  if (!key) return '';
  const number = frontmatter.slice(key.index + key[0].length).match(TURNS_NUMBER)?.[1];
  return number ? `maxTurns ${number}` : 'maxTurns set';
}

/**
 * Whether `token` stands in `text` as a whole name: not inside a longer run of letters, digits, `_` or `-`.
 * @param {string} text - the text searched (untrusted).
 * @param {string} token - the name looked for; an empty one is never found.
 * @returns {boolean} true when at least one whole match exists.
 */
export function hasToken(text, token) {
  if (token === '') return false;
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    const before = text[at - 1] ?? '';
    const after = text[at + token.length] ?? '';
    if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return true;
  }
  return false;
}
