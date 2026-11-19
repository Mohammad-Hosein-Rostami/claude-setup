// The frontmatter of an agent file: found the way Claude Code finds it, then read only when it is in a strict plain subset of YAML.
// Exports: frontmatterOf(head), plainFrontmatter(text).
// Read from the Claude Code 2.1.328 bundle (function names are the minified ones) and probed on that CLI with
// `claude --agent zzz-none -p hi` in a temp HOME; re-read and re-probe when the CLI changes its parser:
//   fR(e){return e.charCodeAt(0)===65279?e.slice(1):e}     a leading BOM is dropped
//   KI=/^---\s*\n([\s\S]*?)---\s*\n?/                      the opening is --- plus whitespace up to its last line end; the
//   qc(): e.indexOf("---",3)<0?null:e.match(KI)            frontmatter ends at the first --- after it, wherever that stands;
//                                                          without a second --- the file has no frontmatter
//   ou(e,r){return e}  (what `normalizeKeys:!0` calls)     keys are NOT normalised: only `name` and `maxTurns`, spelled so, count
//                                                          (probe: `max_turns`, `max-turns`, `maxturns` and `Name` are other keys)
//   Xyn(): let{name:k}=r;if(!k||typeof k!=="string")return null   an agent's name is its `name` value only, never the file name:
//                                                          a file without a string `name` is not an agent (probe: not listed)
//   L9 = Bun.YAML.parse; on an error one more try with nu(), which puts quotes around a value that holds one of {}[]*&#!|>%@` or ": "
//                                                          (probe: `name: x # c` is "x", but "x # c" when another line fails first)
//   probes: a mapping indented as a whole, or by tabs, loads; a lone CR ends a line; `name : x`, `name:<tab>x` and a value continued
//   on a deeper line ("a b") load; of two `name` keys the last one wins.
// This file does not parse YAML. It reads the subset below exactly, and calls every other frontmatter "not plain", which the note
// reports as "check by hand" without a claim about its name or maxTurns. The subset: the mapping's indent is that of its first key
// line; a line at that indent is blank, a # comment or `key:` followed by the end of the line or a space, the key being
// [A-Za-z_][A-Za-z0-9_-]*; deeper lines belong to the value above them and are not read, and so do `- item` lines at the mapping's
// indent below a key line without a value (the usual way to write `tools:` as a list). Not plain: any other line at that indent
// or a shallower one, a tab in an indent, a control character or a Unicode line separator, a quoted value that does not end on its
// line, a `name` or `maxTurns` key that occurs twice, has a deeper line below it or is spelled in another case or with _ or -
// (should a later CLI normalise keys), and a `name` value that is not plain words or a simple quoted text (see nameOf).
// Known limits, both on the side of saying too much: a file whose YAML fails in a value this file does not read is not loaded by
// the CLI but is still reported; so is a `name` that YAML reads as a number or a boolean, and an agent without a `description`.
// Invariants: pure; linear time in the text. The CLI's own regex is not run: its `\s*\n` backtracks over a long run of line ends.
const BYTE_ORDER_MARK = 0xfeff;
const FENCE = '---';
const OPENING = /^---\s*/;
const LINE_END = /\r\n|\n|\r/;
// C0 controls other than tab and the line ends, DEL, NEL and the Unicode line and paragraph separators: no plain frontmatter has them.
const UNSAFE_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;
const INDENT = /^[ \t]*/;
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/;
const SEQUENCE_ITEM = /^-(?: |$)/; // `- item`: YAML lets a list stand at its key's own indent when the key line has no value
const KEY_JOINERS = /[_-]/g;
const NAME_KEY = 'name';
const TURNS_KEY = 'maxTurns';
const WATCHED_KEYS = new Map([[NAME_KEY, NAME_KEY], [TURNS_KEY.toLowerCase(), TURNS_KEY]]); // folded spelling to the spelling that counts
const QUOTES = ['"', "'"];
const ESCAPE = '\\';
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?: [A-Za-z0-9_.-]+)*$/; // words of letters, digits, _ . - with single spaces between
const QUOTED_NAME_TEXT = /^[ !#-&(-[\]-~]*$/; // printable ASCII without both quotes and the backslash: nothing YAML would decode
const TURNS_NUMBER = /^["']?(\d{1,6})["']?(?:\s+#.*)?$/; // one to six digits, quoted or not, then at most a comment

const NO_FRONTMATTER = Object.freeze({ kind: 'none', text: '' });
const NOT_PLAIN = Object.freeze({ plain: false });

/**
 * The frontmatter of an agent file, by Claude Code's own rules.
 * @param {string} head - the start of the file (the caller reads a capped head, so the closing --- may lie past it).
 * @returns {{ kind: 'none' | 'open' | 'closed', text: string }} `none`: no opening --- line, the CLI reads no frontmatter; `open`: an
 *   opening and no --- after it in `head` (in a whole file that is no frontmatter either; in a cut head it is unknown); `closed`:
 *   `text` is what stands between the opening line and the first --- after it, the indent of its first line included.
 */
export function frontmatterOf(head) {
  const text = head.charCodeAt(0) === BYTE_ORDER_MARK ? head.slice(1) : head;
  const opening = OPENING.exec(text)?.[0] ?? '';
  const start = opening.lastIndexOf('\n') + 1; // the CLI's `\s*\n` ends at the last line end of that whitespace
  if (start === 0) return NO_FRONTMATTER;
  const end = text.indexOf(FENCE, start);
  return end < 0 ? { kind: 'open', text: '' } : { kind: 'closed', text: text.slice(start, end) };
}

/**
 * The key lines of a frontmatter that is in the plain subset.
 * @param {string} text - the frontmatter text.
 * @returns {{ key: string, value: string, continued: boolean, valueBelow: boolean }[] | undefined} one entry per key line: `continued`
 *   when a deeper line or a list item follows it, `valueBelow` when the key line itself holds no value; undefined when a line is
 *   outside the subset.
 */
function keyLines(text) {
  if (UNSAFE_CHARACTER.test(text)) return undefined;
  const found = [];
  let indent;
  for (const line of text.split(LINE_END)) {
    if (BLANK_OR_COMMENT.test(line)) continue;
    const lead = INDENT.exec(line)[0];
    if (lead.includes('\t')) return undefined;
    indent ??= lead.length;
    const listItem = lead.length === indent && SEQUENCE_ITEM.test(line.slice(indent)) && found.at(-1)?.valueBelow === true;
    if (lead.length > indent || listItem) {
      found.at(-1).continued = true; // the first line that counts sets the indent, so a deeper line always has a key line above it
      continue;
    }
    const key = lead.length === indent ? KEY_LINE.exec(line.slice(indent)) : null;
    if (!key) return undefined;
    const value = (key[2] ?? '').trim();
    found.push({ key: key[1], value, continued: false, valueBelow: value === '' || value.startsWith('#') });
  }
  return found;
}

/** Where the quoted text that starts `value` ends: the index after its closing quote, or -1 when the line ends first. */
function quoteEnd(value) {
  const quote = value[0];
  for (let at = 1; at < value.length; at += 1) {
    if (quote === '"' && value[at] === ESCAPE) at += 1;
    else if (value[at] === quote && quote === "'" && value[at + 1] === quote) at += 1;
    else if (value[at] === quote) return at + 1;
  }
  return -1;
}

/** Whether a value that starts with a quote also ends on its line, with at most a comment after it (a value without a quote: true). */
function endsOnItsLine(value) {
  if (!QUOTES.includes(value[0])) return true;
  const end = quoteEnd(value);
  return end > 0 && BLANK_OR_COMMENT.test(value.slice(end));
}

/**
 * The agent name a `name` value gives, when that is certain.
 * @param {string} value - the text after `name: `, trimmed.
 * @returns {string | undefined} '' for no value (or only a comment): the CLI then loads no agent; the name for plain words or for a
 *   quoted text without a quote or backslash inside; undefined for anything YAML could read another way (an escape, | or >, an
 *   anchor, alias or tag, a comment after the value, non-ASCII).
 */
function nameOf(value) {
  if (value === '' || value.startsWith('#')) return '';
  if (PLAIN_NAME.test(value)) return value;
  const inner = QUOTES.includes(value[0]) && value.at(-1) === value[0] && value.length > 1 ? value.slice(1, -1) : undefined;
  return inner !== undefined && QUOTED_NAME_TEXT.test(inner) ? inner : undefined;
}

/**
 * What a frontmatter says about the agent's name and its maxTurns, when it is in the plain subset (see the header).
 * @param {string} text - the frontmatter text from frontmatterOf.
 * @returns {{ plain: false } | { plain: true, name: string, turns: string }} `name`: the exact agent name, '' when there is none
 *   (the CLI then loads no agent from the file); `turns`: '' without a `maxTurns` key line, `maxTurns <n>` for a number of at most
 *   six digits, else `maxTurns set`, so that nothing else of the value (untrusted text) reaches the note.
 */
export function plainFrontmatter(text) {
  const lines = keyLines(text);
  if (!lines) return NOT_PLAIN;
  const read = { plain: true, name: '', turns: '' };
  const seen = new Set();
  for (const { key, value, continued } of lines) {
    if (!endsOnItsLine(value)) return NOT_PLAIN;
    const watched = WATCHED_KEYS.get(key.toLowerCase().replace(KEY_JOINERS, ''));
    if (watched === undefined) continue;
    if (key !== watched || continued || seen.has(key)) return NOT_PLAIN;
    seen.add(key);
    const name = key === NAME_KEY ? nameOf(value) : '';
    if (name === undefined) return NOT_PLAIN;
    if (key === NAME_KEY) read.name = name;
    else read.turns = `${TURNS_KEY} ${TURNS_NUMBER.exec(value)?.[1] ?? 'set'}`;
  }
  return read;
}
