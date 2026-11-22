// Reads the text of a package.json script as plain words, never as shell text (design 3.2): a part is usable only when every word is
// made of safe characters, and only then is it matched to tsc, vitest, jest or `node --test`.
// Exports: plainWords, splitScript, forwardedFlags, nodeTestGlobs, tscCommands.
// Invariants: a word with a shell character (dollar, backtick, parentheses, redirects, pipe, ampersand, semicolon, backslash, tilde, hash,
//   quote or space) makes its whole part unusable (null); nothing here runs anything or touches the file system.

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./*?{}[\]-]+$/; // no $ ` ( ) < > | & ; \ ~ # quote or space: nothing a shell would act on
const NODE_BOOLEAN_FLAGS = new Set(['--test', '--experimental-test-coverage']);
const NODE_VALUE_FLAGS = new Set(['--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout']);
const TSC_UNSUPPORTED = new Set(['-b', '--build', '-w', '--watch', '--init', '--showConfig']);

/** The words of one script part, or null when any word is not plain (so it is never given to anything). Whole-word quotes are removed. */
export function plainWords(part) {
  const words = (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => (/^(["']).*\1$/.test(word) ? word.slice(1, -1) : word));
  return words.length > 0 && words.every((word) => PLAIN_WORD.test(word)) ? words : null;
}

export const splitScript = (script) => script.split(/&&|;|\n/).map((part) => part.trim()).filter(Boolean);

/** The value of each flag of `names` in `words`, as flag/value pairs (`--flag value` and `--flag=value`). */
export function forwardedFlags(words, names) {
  const forwarded = [];
  words.forEach((word, at) => {
    const [name, ...inline] = word.split('=');
    if (!names.has(name)) return;
    const value = inline.length > 0 ? inline.join('=') : words[at + 1];
    if (value !== undefined && !value.startsWith('-')) forwarded.push(name, value);
  });
  return forwarded;
}

/** The words after `node` that are globs, or null when a flag other than the node:test ones is present (it changes how tests load). */
export function nodeTestGlobs(words) {
  const globs = [];
  for (let at = 1; at < words.length; at += 1) {
    const [name] = words[at].split('=');
    if (NODE_BOOLEAN_FLAGS.has(name)) continue;
    if (NODE_VALUE_FLAGS.has(name)) { if (!words[at].includes('=')) at += 1; continue; }
    if (words[at].startsWith('-')) return null;
    globs.push(words[at]);
  }
  return words.includes('--test') ? globs : null;
}

/** The tsc arguments of each `&&` part when the script is only plain tsc commands (no build or watch mode), else null. */
export function tscCommands(script) {
  const parts = script.split('&&').map((part) => part.trim());
  const commands = parts.map((part) => plainWords(part));
  const only = commands.every((words) => words && words[0] === 'tsc' && !words.some((word) => TSC_UNSUPPORTED.has(word)));
  return only ? commands.map((words) => words.slice(1)) : null;
}

