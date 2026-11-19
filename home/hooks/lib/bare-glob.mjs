// Glob syntax of one `rm -r` target: which folder does its trailing run of bare globs list? Read by lib/rm-paths.mjs.
// Exports: globbedFolder(target) -> folder text | undefined.
// A bare glob is a path part made only of `*`, `?`, dots and bracket sets, with one of the globs among them: it matches
// every entry of its folder (or every hidden one), so `rm -r` of it empties the folder. `*.log` and `a*` have a name part and are not bare.
// Every bracket form of the shell is a set: `[a-z]`, `[!.]`, `[^.]`, a `]` in first place (`[]a]`), and the POSIX classes, equivalence
// classes and collating symbols inside one (`[[:alnum:]]`, `[[=a=]]`, `[[.hyphen.]]`). A set that never closes is a plain name, as in bash.
// A bare glob below a bare glob (`./**/*`, `*/*`) lists the folder the first one is in: it empties every sub-folder there. Repeated and
// trailing slashes are skipped.
// Invariants: pure, no regular expression. The target is read once, from its end, by index: no copy is made per path part, so the work
// and the memory are linear in the target's length (a pattern per part once took the hook down on a 32 KB target).

const GLOB_PART = 'glob';
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

/** What the path part `text[start, end)` is: GLOB_PART for a bare glob, NAME_PART for anything with a name in it. */
function partKind(text, start, end) {
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
  let cut = target.length; // the trailing bare globs start here
  let partEnd = cut;
  while (partEnd > 0) {
    while (partEnd > 0 && target[partEnd - 1] === '/') partEnd--;
    let partStart = partEnd;
    while (partStart > 0 && target[partStart - 1] !== '/') partStart--;
    if (partEnd === 0 || partKind(target, partStart, partEnd) === NAME_PART) break;
    cut = partStart;
    partEnd = partStart;
  }
  if (cut === target.length) return undefined;
  return cut === 0 ? '.' : target.slice(0, cut);
}
