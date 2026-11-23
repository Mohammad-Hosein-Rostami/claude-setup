// How a writer brief names its own lane worktree: the `worktree: <absolute path>` field (exact case) and its value, read from brief text
// without looking anything up. lib/writer-agents.mjs checks the value with git and builds the gate's advice from it.
// A field opens a trimmed line, follows a Markdown list marker (`- worktree: ...`), or follows a header separator: `·` or `|` always
// (`BASE: <sha> · BRANCH: <name> · worktree: <path>`), `,` or `;` only when every part before it is a `KEY: value` field, since they are
// prose punctuation too ("Lane A landed, worktree: /a, leave it" names a sibling lane, not this writer's). A value in quote marks is read
// whole (a folder may hold `|` or `; `); else it ends at the next `·` or `|`, or a `;` or `,` before a blank.
// Exports: worktreeValues(text) (a text's field values, in order), namedWorktrees(texts) -> {fields, values, many}, unquoted(word).
// Invariants: pure and linear in the text (one walk per line, at most MAX_WORKTREE_LINES + 1 values read per text); the caller bounds the
// text it passes. A brief names many worktrees when it has two distinct values or more fields than the cap: the rest is unread, so the
// caller never picks one.

const WORKTREE_PREFIX = 'worktree:';
const LIST_MARKER = /^[-*+][ \t]+/;
const HEADER_SEPARATORS = '·|;,';
const FIELD_SEPARATORS = '·|'; // always a header separator; `,` and `;` are prose punctuation too, so they count only in a KEY_FIELD header
const KEY_FIELD = /^\s*[A-Za-z][\w-]*:\s*\S/; // a `KEY: value` header field (`BASE: <sha>`, `BRANCH: <name>`)
const VALUE_END = /[·|]|[;,](?=\s|$)/; // a value ends at the next · or |, or a ; or , before a blank or the end (a path may hold ; or ,)
const VALUE_QUOTES = '"\'`'; // a value in these marks is read whole, up to its closing mark (it may hold any separator)
// A brief names one lane worktree (it may repeat it); more fields than this are refused as naming many. Only one distinct value is ever
// looked up, so a launch makes at most one git call
const MAX_WORKTREE_LINES = 8;
const SURROUNDING_MARKS = '`\'"()';
const TRAILING_PUNCTUATION = ',.;:';

/**
 * The word without quotes, backticks and brackets around it and without trailing sentence punctuation (a loop: linear in its length).
 * @param {string} word a field value or a word of a prompt (a brief file path)
 * @returns {string} the word without those marks
 */
export function unquoted(word) {
  let start = 0;
  let end = word.length;
  while (start < end && SURROUNDING_MARKS.includes(word[start])) start += 1;
  while (end > start && (SURROUNDING_MARKS + TRAILING_PUNCTUATION).includes(word[end - 1])) end -= 1;
  return word.slice(start, end);
}

/**
 * The value of a field from `rest`, the text after its `worktree:`, and how many characters of `rest` it takes: a value in quote marks
 * whole, up to its closing mark (`"/x/lane|y"`); else up to VALUE_END, without the marks and punctuation around it.
 */
function fieldValue(rest) {
  const start = rest.length - rest.trimStart().length;
  const close = VALUE_QUOTES.includes(rest[start]) ? rest.indexOf(rest[start], start + 1) : -1;
  if (close !== -1) return { value: rest.slice(start + 1, close).trim(), taken: close + 1 };
  const end = rest.search(VALUE_END);
  const taken = end === -1 ? rest.length : end;
  return { value: unquoted(rest.slice(0, taken).trim()), taken };
}

/**
 * The `worktree:` values of one trimmed line, at most `limit`, in one walk over its segments (linear in the line). A field opens the line
 * or a segment after `·` or `|`, or after `,` or `;` when every segment before it is a `KEY: value` field: in "Lane A landed, worktree:
 * /a, leave it" the comma is prose. A separator inside a value read belongs to the value.
 */
function lineFields(body, limit) {
  const values = [];
  let header = true; // every segment so far is a KEY_FIELD (or a field read)
  let readUpTo = 0; // the end of the last value read
  for (let start = 0, before = ''; start <= body.length && values.length < limit;) {
    let end = start;
    while (end < body.length && !HEADER_SEPARATORS.includes(body[end])) end += 1;
    if (start >= readUpTo) {
      const segment = body.slice(start, end);
      const at = start + segment.length - segment.trimStart().length;
      if (body.startsWith(WORKTREE_PREFIX, at) && (start === 0 || FIELD_SEPARATORS.includes(before) || header)) {
        const { value, taken } = fieldValue(body.slice(at + WORKTREE_PREFIX.length));
        values.push(value);
        readUpTo = at + WORKTREE_PREFIX.length + taken;
      } else header &&= KEY_FIELD.test(segment);
    }
    before = body[end];
    start = end + 1;
  }
  return values;
}

/** The `worktree:` fields of a text, in order, as { line, value }: at most `limit`, so each value's scan to its end runs a bounded number of times. */
function worktreeFields(text, limit) {
  const fields = [];
  for (const line of text.split(/\r?\n/)) {
    for (const value of lineFields(line.trim().replace(LIST_MARKER, ''), limit - fields.length)) fields.push({ line, value });
    if (fields.length >= limit) break;
  }
  return fields;
}

/**
 * The `worktree:` fields of the brief texts and whether the brief names more than one worktree.
 * @param {string[]} texts the prompt's head and the heads of the brief files it names
 * @returns {{fields: Array<{line: string, value: string}>, values: string[], many: boolean}} the fields (at most one past
 *   MAX_WORKTREE_LINES per text), their distinct values in order, and many: two distinct values, or more fields than MAX_WORKTREE_LINES
 */
export function namedWorktrees(texts) {
  const fields = texts.flatMap((text) => worktreeFields(text, MAX_WORKTREE_LINES + 1));
  const values = [...new Set(fields.map(({ value }) => value))];
  return { fields, values, many: values.length > 1 || fields.length > MAX_WORKTREE_LINES };
}

/**
 * The values of a text's `worktree:` fields, unquoted, in order; pure (nothing is looked up), and the caller bounds the text.
 * @param {string} text a brief or its head
 * @returns {string[]} at most MAX_WORKTREE_LINES values
 */
export const worktreeValues = (text) => worktreeFields(text, MAX_WORKTREE_LINES).map(({ value }) => value);
