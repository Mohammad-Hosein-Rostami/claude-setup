// X3 of the Bash guard: text another program runs, in a line that moves the folder. Read by lib/raw-risk.mjs.
// Exports: deletesInMovedText(visible, statements) -> boolean; findDeletes(after) -> boolean; WINDOW.
// Once the line has a `cd`, `pushd` or `popd`, the quoted text of a program (`trap '...'`, `watch '...'`, `<<< '...'`, `python3 -c "..."`) and the
// body of a heredoc a program reads (`ssh host <<EOF`, `xargs <<EOF`, `bash <<EOF`) may run in a folder the guard did not follow, so a recursive
// rm or a deleting find in it asks whatever its path. A heredoc that only stores or prints its body (cat, tee, `git commit -F -`) is gone from
// `visible` before this runs. Plain `cd src && rm -rf build` is not read here: the per-command rules judge it.
// Invariants: pure, no I/O; linear in the text length.

export const WINDOW = 12; // words after a verb that still count as its arguments
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/;
const MOVERS = new Set(['cd', 'pushd', 'popd']);
const RECURSIVE_RM_FLAG = /^(?:-[a-zA-Z]*[rR]|--r)/;
const QUOTED_TEXT = /'([^']*)'|"((?:[^"\\]|\\.)*)"/g;
const TEXT_WORD_BREAK = /[\s;&|()`]+/;
const HEREDOC_OPEN = /(?<!<)<<-?[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\?([A-Za-z_]\w*))/;

/** True when a `find` deletes what it matches: `-delete`, or `-exec`/`-execdir`/`-ok` running rm (its `{}` path hides the target from the rm check). */
export const findDeletes = (after) => after.includes('-delete') || after.some((w, i) => FIND_EXEC.test(w) && after[i + 1] === 'rm');

/**
 * The text a heredoc hands its reader: the body lines up to the terminator line (all the rest of the text when there is none), and what
 * follows the delimiter on the opening line (the body words that lib/raw-risk.mjs joined onto an `xargs` line).
 * @param {string} text the command text
 * @returns {string[]} one text per heredoc
 */
function heredocTexts(text) {
  const lines = text.split('\n');
  const texts = [];
  for (let i = 0; i < lines.length; i++) {
    const open = HEREDOC_OPEN.exec(lines[i]);
    if (open === null) continue;
    const delimiter = open[1] ?? open[2] ?? open[3];
    const end = lines.findIndex((line, at) => at > i && line.trim() === delimiter);
    texts.push(lines[i].slice(open.index + open[0].length), ...(end === -1 ? [] : [lines.slice(i + 1, end).join('\n')]));
    if (end !== -1) i = end;
  }
  return texts;
}

/** True when the words hold a recursive rm with a path, or a deleting find. */
const hasDelete = (words) =>
  words.some((word, i) => {
    const after = words.slice(i + 1, i + 1 + WINDOW);
    if (word === 'rm') return after.some((w) => RECURSIVE_RM_FLAG.test(w)) && after.some((w) => !w.startsWith('-'));
    return word === 'find' && findDeletes(after);
  });

/**
 * @param {string} visible the text without data arguments and plain heredocs
 * @param {string[][]} statements its statements' words
 * @returns {boolean} true when such a delete is in the quoted text or a heredoc body of a line that moves the folder
 */
export function deletesInMovedText(visible, statements) {
  if (!statements.some((words) => words.some((word) => MOVERS.has(word)))) return false;
  const quoted = [...visible.matchAll(QUOTED_TEXT)].map(([, single, double]) => single ?? double);
  return [...quoted, ...heredocTexts(visible)].some((text) => hasDelete(text.split(TEXT_WORD_BREAK).filter(Boolean)));
}
