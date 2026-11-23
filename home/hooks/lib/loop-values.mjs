// Plain `for` lists (fixes spec X7): in `for NAME in w1 … wn; do … done` whose every wi is a plain literal word, each command of the loop body
// that uses $NAME is judged once per value (w1 … wn filled in), instead of asking about "a word filled in at run time".
// Exports: PLAIN_LOOP_WORD, MAX_LOOP_READINGS, plainLoopValues(line) -> Map<name, string[]>, newLoopWalk(line), stepLoopWalk(walk, seg),
// segmentViews(seg, scope, walk, readings) -> {seg, readings}[].
// The values are known only when all of these hold on the raw text (an allowlist, P4): the header `for NAME in` appears once for that
// name; every item matches PLAIN_LOOP_WORD (no `$`, glob, quote, backslash, brace, `~`, leading `=` or ANSI-C word); the list ends at `;` or a newline;
// every other mention of NAME is a plain reference (`$NAME`, `${NAME}`) followed by a blank, a quote, a separator or `/ . , - < >`, or a
// flag or file-name part (`-d`, `./d`, `d.txt`) that never names the variable. Anything else (`NAME=`, `read NAME`, `${NAME:-x}`, `$NAME[1]`,
// `$NAME:u`, a second header) leaves the name unknown, which asks as before. A line whose plain lists would give more than
// MAX_LOOP_READINGS combinations knows none of them.
// The walk follows the parsed segments: a value is filled in only between its header and the `done` that closes it, so a `$NAME`
// before the loop, after it, or after a `$( )` or `( )` loop is judged as written. Any `done` with no open loop stops the walk (as written
// from then on). Pure, no I/O.
import { substituteKnownWords } from './rm-paths.mjs';
import { commandReadings } from './shell-hazards.mjs';

// No character that bash or zsh (default options, also EXTENDED_GLOB) expands: no `$`, quote, backslash, glob (`* ? [ ]`, zsh `^ # ~`),
// brace, `~` or `<>`; `=` only after the first character, since zsh's EQUALS option (on by default) turns a leading `=git` into /usr/bin/git.
export const PLAIN_LOOP_WORD = /^[A-Za-z0-9._/:@%+,-][A-Za-z0-9._/:@%+=,-]*$/;
export const MAX_LOOP_READINGS = 64; // combinations of loop values one line may fill in; more is judged as written (asks)
const LOOP_HEADER = /(?<![\w$])for[ \t]+([A-Za-z_]\w*)[ \t]+in[ \t]([^;&|\n]*)/g;
const LIST_END = /^[;\n]/;
const FOLLOWS_REFERENCE = /^(?:$|[\s"';&|)/.,<>-])/;
const NOT_A_USE_BEFORE = new Set(['-', '/', '.']);
const NOT_A_USE_AFTER = new Set(['.', '/']);
const LEADING_WORDS = new Set(['do', 'then', 'else', '{', '!', 'time']); // words that may stand before a loop keyword in its segment
const LOOP_KEYWORDS = new Set(['for', 'while', 'until', 'select']);
const LOOP_END = 'done';

/** True when one mention of the name at `at` is a plain reference or a flag or file-name part (see the header). */
function isPlainMention(line, at, name) {
  const after = line[at + name.length] ?? '';
  if (line[at - 1] === '$') return FOLLOWS_REFERENCE.test(after);
  if (line.slice(at - 2, at) === '${' && after === '}') return FOLLOWS_REFERENCE.test(line.slice(at + name.length + 1));
  return NOT_A_USE_BEFORE.has(line[at - 1]) || NOT_A_USE_AFTER.has(after);
}

/** True when every mention of the name other than its header's is plain (see the header). */
function mentionsArePlain(line, name, headerAt) {
  const mention = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'g');
  return [...line.matchAll(mention)].every(({ index }) => index === headerAt || isPlainMention(line, index, name));
}

/**
 * @param {string} line one command line as written
 * @returns {Map<string, string[]>} each loop name whose values are known (see the header), with its values in order; empty when the
 *   line's plain lists would give more than MAX_LOOP_READINGS combinations
 */
export function plainLoopValues(line) {
  const headers = [...line.matchAll(LOOP_HEADER)];
  const known = new Map();
  for (const header of headers) {
    const [whole, name, list] = header;
    const items = list.trim().split(/[ \t]+/).filter(Boolean);
    const plain = items.length > 0 && items.every((item) => PLAIN_LOOP_WORD.test(item)) && LIST_END.test(line.slice(header.index + whole.length));
    const once = headers.filter((other) => other[1] === name).length === 1;
    if (plain && once && mentionsArePlain(line, name, header.index + whole.indexOf(name, 3))) known.set(name, items);
  }
  const combinations = [...known.values()].reduce((product, values) => product * values.length, 1);
  return combinations > MAX_LOOP_READINGS ? new Map() : known;
}

/**
 * @param {string} line the command line whose segments the walk will follow
 * @returns {{known: Map<string, string[]>, frames: {name?: string, values?: string[]}[], lost: boolean}} a walk before the first segment
 */
export const newLoopWalk = (line) => ({ known: plainLoopValues(line), frames: [], lost: false });

const sameWords = (words, values) => words.length === values.length && words.every((word, at) => word === values[at]);

/**
 * Moves the walk past one segment (call it after the segment was judged): a loop header opens a frame (with values only for a known
 * plain list read the same way by the parser), `done` closes the innermost one.
 * @param {{known: Map<string, string[]>, frames: object[], lost: boolean}} walk from newLoopWalk (modified)
 * @param {string[]} seg the segment's words as parsed
 */
export function stepLoopWalk(walk, seg) {
  if (seg[0] === LOOP_END) {
    if (walk.frames.pop() === undefined) walk.lost = true;
    return;
  }
  let at = 0;
  while (at < seg.length && LEADING_WORDS.has(seg[at])) at++;
  if (!LOOP_KEYWORDS.has(seg[at])) return;
  const name = seg[at + 1];
  const values = walk.known.get(name);
  const plain = seg[at] === 'for' && seg[at + 2] === 'in' && values !== undefined && sameWords(seg.slice(at + 3), values);
  walk.frames.push(plain ? { name, values } : {});
}

const SEGMENT_FLAGS = ['piped', 'arrayList', 'joinedBy', 'unlistedBraces', 'bareWords']; // lib/shell-words.mjs; the same word positions
const withFlags = (words, seg) => SEGMENT_FLAGS.reduce((list, flag) => (seg[flag] === undefined ? list : Object.defineProperty(list, flag, { value: seg[flag] })), words);

/** Every combination of one value per name: [[name, value], ...] lists. */
const combinations = (choices) => choices.reduce((lists, [name, values]) => lists.flatMap((list) => values.map((value) => [...list, [name, value]])), [[]]);

/**
 * The words of one segment once per combination of the open plain loops' values it uses, each filled in as the shell would
 * (lib/rm-paths.mjs substituteKnownWords, on the line's work budget).
 * @param {string[]} seg the segment's words as parsed
 * @param {{vars: Map<string, string>, assigned: Set<string>}} scope the line's variable state (not modified)
 * @param {{frames: {name?: string, values?: string[]}[], lost: boolean}} walk the walk at this segment
 * @returns {string[][] | undefined} one word list per combination (with the segment's parser flags, so it stands in for the segment),
 *   or undefined when the segment uses no open plain loop's name
 */
function loopWordLists(seg, scope, walk) {
  if (walk.lost) return undefined;
  const open = new Map(walk.frames.filter((frame) => frame.name !== undefined).map((frame) => [frame.name, frame.values]));
  const used = [...open].filter(([name]) => seg.some((word) => word.includes(`$${name}`) || word.includes(`\${${name}}`)));
  if (used.length === 0) return undefined;
  return combinations(used).map((pairs) => {
    const vars = new Map([...scope.vars, ...pairs]);
    const assigned = new Set([...scope.assigned, ...pairs.map(([name]) => name)]);
    return withFlags(substituteKnownWords(seg, { ...scope, vars, assigned }), seg);
  });
}

/**
 * The ways the guard judges one segment: as filled in, or once per combination of the open plain loops' values it uses.
 * @param {string[]} seg the segment's words as parsed
 * @param {{vars: Map<string, string>, assigned: Set<string>, splitWords: Set<string>}} scope the line's variable state (not modified)
 * @param {{frames: object[], lost: boolean}} walk the walk at this segment
 * @param {ReturnType<typeof commandReadings>} readings the segment's readings as filled in (lib/shell-hazards.mjs commandReadings)
 * @returns {{seg: string[], readings: ReturnType<typeof commandReadings>}[]} each view's seg stands in for the segment in the rules that read it
 */
export function segmentViews(seg, scope, walk, readings) {
  const lists = loopWordLists(seg, scope, walk);
  return lists === undefined ? [{ seg, readings }] : lists.map((words) => ({ seg: words, readings: commandReadings(words, scope.splitWords) }));
}
