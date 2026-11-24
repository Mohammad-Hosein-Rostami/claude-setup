// Code given to an interpreter on the command line, and the code the Bash guard cannot read. Read by pre-bash-guard.mjs,
// lib/shell-hazards.mjs and lib/other-deleters.mjs.
// Exports: INTERPRETERS; interpreterCode(cmd, args) -> the code text | undefined; buildsCommand(code) -> boolean;
// checkInlineCode(cmd, args) -> reason | undefined; INLINE_COMMAND_REASON, ENCODED_COMMAND_REASON (fixed texts, classed in lib/reason-classes.mjs).
// Why (audit H1): `node -e "require('child_process').execSync('g'+'it push')"` runs `git push`, but no rule sees the word, because the
// code glues it together from pieces. The guard cannot run the code to find out, so code that runs a command (child_process, exec,
// spawn, system, subprocess, popen, Runtime) AND builds text from pieces (a `+` or `.` next to a string, adjacent strings, join,
// a template or f-string slot, chr / fromCharCode / base64 decoding) asks. Code that runs a plain literal command is left to the
// other rules, which read it as words (lib/raw-risk.mjs); a piece of an outward word only hides it once glued to the rest.
// PowerShell's -EncodedCommand (any prefix PowerShell accepts: -e, -ec, -enc ...) runs base64 text the guard cannot read: it asks too.
// Pure, no I/O; every pattern is linear in the code length. A false positive costs one dialog, so both conditions must hold.

/** The interpreters whose `-e`/`-c`/`-p`/`--eval` code the guard reads (also `.exe` and versioned names such as python3.12). */
export const INTERPRETERS = /^(?:node|python[\d.]*|perl|ruby|deno|bun|php)(?:\.exe)?$/;
const CODE_FLAG = /^-[a-zA-Z]*[ecEp]$|^--(?:eval|print)$/;
const CODE_FLAG_ATTACHED = /^--(?:eval|print)=/;
const PHP_CODE_FLAG = '-r'; // php's own flag for code on the command line (`php -e` is something else)
const DENO_EVAL = 'eval'; // `deno eval "<code>"`

/**
 * @param {string} cmd the command name (lib/command-of.mjs)
 * @param {string[]} args its words
 * @returns {string | undefined} the code an interpreter is given on its command line, or undefined when it gets none there
 */
export function interpreterCode(cmd, args) {
  if (!INTERPRETERS.test(cmd)) return undefined;
  if (cmd.startsWith('deno') && args[0] === DENO_EVAL) return args.find((word, at) => at > 0 && !word.startsWith('-'));
  const isCodeFlag = (word) => (cmd.startsWith('php') ? word === PHP_CODE_FLAG : CODE_FLAG.test(word) || CODE_FLAG_ATTACHED.test(word));
  const at = args.findIndex(isCodeFlag);
  if (at === -1) return undefined;
  return CODE_FLAG_ATTACHED.test(args[at]) ? args[at].slice(args[at].indexOf('=') + 1) : args[at + 1];
}

const RUNS_COMMAND = /child_process|\bexec\w*|\bspawn\w*|\bsystem\s*\(|subprocess|popen|\bRuntime\b|shell_exec|passthru|proc_open|\bqx\b|Open3|Deno\.(?:Command|run)\b/i;
// a string glued to something: `'g'+'it'`, `'gi'.'t'` (Perl, PHP), `'gi' 't'` (Python joins adjacent strings), `x + 'push'`
const GLUED_STRING = /['"`][ \t]*(?:\+|\.(?![\w$])|['"`])|(?:\+|\.)[ \t]*['"`]/;
// other ways to build text: join, a template or f-string slot, character codes, base64 decoding, reversing
const BUILT_TEXT = /\bjoin\s*\(|\$\{|\bf['"][^'"]*\{|fromCharCode|\bchr\s*\(|\batob\s*\(|b64decode|base64|Buffer\.from|\bdecode\s*\(|\[::-1\]|\breverse\s*\(/;
/**
 * @param {string} code interpreter code (from the command line or a heredoc)
 * @returns {boolean} true when the code runs a command and builds text from pieces (a piece of an outward word such as `'it pu'`
 *   is only dangerous glued to the rest; a whole literal `git push` is read by lib/raw-risk.mjs, which also bounces it for a rewrite)
 */
export const buildsCommand = (code) => RUNS_COMMAND.test(code) && (GLUED_STRING.test(code) || BUILT_TEXT.test(code));

export const INLINE_COMMAND_REASON = 'interpreter code runs a command it builds from pieces, so the guard cannot see what runs; '
  + 'write the command out in its own Bash call';
export const ENCODED_COMMAND_REASON = 'PowerShell -EncodedCommand runs base64 text the guard cannot read; decode it and write the command out';

const POWERSHELLS = /^(?:powershell|pwsh)(?:\.exe)?$/i;
const ENCODED_NAMES = ['encodedcommand', 'encodedarguments']; // PowerShell accepts any unambiguous prefix (`-enc`, `-encodedc`)
const ENCODED_SHORT = new Set(['e', 'ec', 'ea']); // the short names PowerShell documents for them

/** True for `-EncodedCommand` or a name PowerShell reads as it: `-e`, `-ec`, `-enc`, `-encodedc` ... (also `--` or `/` in front). */
function isEncodedFlag(word) {
  const name = /^(?:--?|\/)([a-z]+)$/i.exec(word)?.[1]?.toLowerCase();
  if (name === undefined) return false;
  return ENCODED_SHORT.has(name) || (name.length >= 2 && ENCODED_NAMES.some((full) => full.startsWith(name)));
}

/**
 * Interpreter code that builds the command it runs, and PowerShell -EncodedCommand.
 * @param {string} cmd the command name (lib/command-of.mjs)
 * @param {string[]} args its words
 * @returns {string | undefined} the ask reason, or undefined
 */
export function checkInlineCode(cmd, args) {
  if (POWERSHELLS.test(cmd) && args.some(isEncodedFlag)) return ENCODED_COMMAND_REASON;
  const code = interpreterCode(cmd, args);
  return typeof code === 'string' && buildsCommand(code) ? INLINE_COMMAND_REASON : undefined;
}
