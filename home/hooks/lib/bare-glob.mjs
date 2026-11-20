// Glob syntax of one `rm -r` target: which folder does its trailing run of bare globs list? Read by lib/rm-paths.mjs.
// Exports: globbedFolder(target) -> folder text | undefined; groupBranches(segs, index) -> extra targets.
// A bare glob is a path part made only of `*`, `?`, dots and bracket sets, with one of the globs among them: it matches
// every entry of its folder (or every hidden one), so `rm -r` of it empties the folder. `*.log` and `a*` have a name part and are not bare.
// Every bracket form of the shell is a set: `[a-z]`, `[!.]`, `[^.]`, a `]` in first place (`[]a]`), and the POSIX classes, equivalence
// classes and collating symbols inside one (`[[:alnum:]]`, `[[=a=]]`, `[[.hyphen.]]`). A set that never closes is a plain name, as in bash.
// A bare glob below a bare glob (`./**/*`, `*/*`) lists the folder the first one is in: it empties every sub-folder there. The run is
// read as the shell normalises it: `.` parts and repeated or trailing slashes are skipped, so `./*/./*` is `*/*`.
// A zsh glob group (`(*|.*)`, `./(*)`) never reaches a target word: both parsers cut a line at `(`, `|` and `)`. groupBranches reads the
// branches back from the segments that follow the rm, and each one is judged as a target.
// Invariants: pure, no regular expression in the target reader. The target is read once, from its end, by index: no copy is made per path part, so the work
// and the memory are linear in the target's length (a pattern per part once took the hook down on a 32 KB target).

const GLOB_PART = 'glob';
const DOT_PART = 'dot'; // a lone `.`: the same folder again
const NAME_PART = 'name';

const CLASS_MARKS = ':=.'; // `[:alnum:]`, `[=a=]`, `[.hyphen.]` inside a bracket set

/**
 * Index just past a class (`[:alnum:]`) that opens at `open` inside a bracket set; `open + 1` when it never closes before `end` (then
 * its `[` is an ordinary member). `unclosed` remembers the marks already searched to the end of this part, so each is searched once
 * and the part is still read in linear time.
 */
function classEnd(text, open, end, unclosed) {
  const mark = text[open + 1];
  if (unclosed.has(mark)) return open + 1;
  for (let at = open + 2; at + 1 < end; at++) if (text[at] === mark && text[at + 1] === ']') return at + 2;
  unclosed.add(mark);
  return open + 1;
}

/** Index just past the `]` that closes the bracket set opening at `open`, or -1 when none does (bash then reads `[` as a plain character). */
function bracketEnd(text, open, end, unclosed) {
  let at = open + 1;
  if (text[at] === '!' || text[at] === '^') at++;
  if (text[at] === ']') at++; // a `]` in first place is a member, not the end
  while (at < end && text[at] !== ']') at = text[at] === '[' && CLASS_MARKS.includes(text[at + 1] ?? ' ') ? classEnd(text, at, end, unclosed) : at + 1;
  return at < end ? at + 1 : -1;
}

/** What the path part `text[start, end)` is: GLOB_PART for a bare glob, DOT_PART for `.`, NAME_PART for anything with a name in it (`..` too). */
function partKind(text, start, end) {
  if (end - start === 1 && text[start] === '.') return DOT_PART;
  const unclosed = new Set();
  let globs = 0;
  let at = start;
  while (at < end) {
    const close = text[at] === '[' ? bracketEnd(text, at, end, unclosed) : at + 1;
    if (close === -1 || !'*?.['.includes(text[at])) return NAME_PART;
    if (text[at] !== '.') globs++;
    at = close;
  }
  return globs > 0 ? GLOB_PART : NAME_PART;
}

/**
 * The folder whose entries a target lists with its trailing bare globs: `*` lists `.`, `/*` lists `/`, `src/*` lists `src/`, and a glob
 * below a glob (`*` under `./**`) lists `./`.
 * @param {string} target one rm target, variables already filled in
 * @returns {string | undefined} the folder as written (`.` when the globs stand alone), or undefined when the target ends in a name
 *   (`src`, `*.log`, `dist` under `*`): then it lists no folder
 */
export function globbedFolder(target) {
  let cut = target.length; // the trailing run of bare globs and `.` parts starts here
  let sawGlob = false;
  let partEnd = cut;
  while (partEnd > 0) {
    while (partEnd > 0 && target[partEnd - 1] === '/') partEnd--;
    let partStart = partEnd;
    while (partStart > 0 && target[partStart - 1] !== '/') partStart--;
    const kind = partEnd === 0 ? NAME_PART : partKind(target, partStart, partEnd);
    if (kind === NAME_PART) break;
    sawGlob ||= kind === GLOB_PART;
    cut = partStart;
    partEnd = partStart;
  }
  if (!sawGlob) return undefined;
  return cut === 0 ? '.' : target.slice(0, cut);
}

const GROUP_OPENS = /^\(+$/; // the join of a segment that a `(` right after the words before it opened
const GROUP_BRANCH = '|';

/**
 * The branches of a zsh glob group written right after the words of segment `index` (`rm -rf (*|.*)`, `rm -rf ./(*)`), as targets.
 * The group's branches arrive as the next segments: the first joined by `(`, the others by `|`. zsh expands such a group without
 * EXTENDED_GLOB, and `(*|.*)` lists every entry of the folder, hidden ones too. In bash an unquoted `(` in that place is a syntax
 * error, so reading the branches as targets adds no ask to a line bash would run. A quoted `'(*)'` is one word and stays a name.
 * @param {(string[] & {joinedBy?: string})[]} segs the line's segments (lib/shell-words.mjs)
 * @param {number} index the segment whose words the group follows
 * @returns {string[]} each branch word, alone and glued to the segment's last word unless that is an option (`./` + `*`); [] without a group
 */
export function groupBranches(segs, index) {
  const branches = [];
  for (let at = index + 1; at < segs.length; at++) {
    const join = segs[at].joinedBy ?? '';
    if (!(at === index + 1 ? GROUP_OPENS.test(join) : join === GROUP_BRANCH)) break;
    branches.push(...segs[at]);
  }
  const last = segs[index].at(-1) ?? '';
  return branches.flatMap((branch) => (last.startsWith('-') ? [branch] : [branch, last + branch]));
}
