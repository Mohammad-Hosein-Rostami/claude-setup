// Purpose: quote one word of a command line a person copies from git-tidy's or land's output, so it pastes into a POSIX shell.
// Exports: shellWord.
// Invariants: a POSIX shell reads the result back as exactly `text`; a word of only safe characters stays as it is.

/**
 * `text` as one POSIX shell word: unchanged when it holds only letters, digits and `_./:@%+=,-`, else in single quotes (each `'`
 * written as `'\''`). Why: a pasted step must work for a path with a space or a quote in it.
 * @param {string} text the word
 * @returns {string} the word, quoted when it needs to be
 */
export const shellWord = (text) => (/^[\w./:@%+=,-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);
