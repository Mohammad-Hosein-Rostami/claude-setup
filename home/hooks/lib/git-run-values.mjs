// The values of the variables git runs (lib/git-runs.mjs COMMAND_ENV: GIT_EDITOR, GIT_PAGER, GIT_SSH_COMMAND, EDITOR ...) wherever a command
// line assigns one: in front of a command (`X=1 cmd`, `env X=1 cmd`), as a statement, after export|declare|typeset|local|readonly (any
// options), and in `${NAME:=value}` / `${NAME=value}`. Git need not follow in the line: a later git, or a program that runs git, reads it.
// Exports: gitRunValueReasons(words, parsed, env, reasonsOf) -> string[]; judgeOnce(text, env, reasonsOf) -> string[]; namesWrittenIn(line).
// A value the guard can read (literal text, `~`, $HOME and the variables it resolves) is judged as a nested command; one it cannot read
// (`$(`, a backtick, `${...}` with an operator, `+=` onto an unknown value, another variable) asks GIT_UNREADABLE_REASON, except a value that
// is exactly one reference to a variable the line does not write (`"$EDITOR"`, `${VISUAL}`): git runs that inherited value anyway. Both
// parsers lose a value given as an unquoted backtick; lib/raw-risk.mjs asks for that one.
// Pure, no I/O. judgeOnce checks each distinct text at most twice per command line (in its directory, then once with the directory
// unknown), so a value that many git commands or assignments repeat costs one check; the caller's MAX_NESTING bounds the depth.
import { COMMAND_ENV, GIT_UNREADABLE_REASON } from './git-runs.mjs';
import { DECLARERS } from './rm-paths.mjs';
import { SPLIT_VARIABLE_REASON, VARIABLE_COMMAND_REASON } from './shell-hazards.mjs';

const RUN_NAMES = new Set(COMMAND_ENV);
const ASSIGNMENT = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/;
const DEFAULT_ASSIGNMENT = /\$\{([A-Za-z_]\w*):?=([^}]*)\}/g; // assigns when the variable is unset (`:=` also when it is empty)
const ONE_REFERENCE = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/;
const REFERENCE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
// what is left once the references the guard resolves are gone: a substitution, a variable, or a `$` that ends the value (the parsers
// end a value there when they split off an unquoted `$(...)`)
const EXPANSION = /`|\$(?:[\w{(@*#?!$-]|$)/;
const HOME = 'HOME';
// a value is judged as a command, and a variable as its command word is the value's own (lib/git-runs.mjs filters it the same way)
const VARIABLE_COMMAND_REASONS = new Set([VARIABLE_COMMAND_REASON, SPLIT_VARIABLE_REASON]);

/**
 * Whether a command line may write a variable: its name stands somewhere other than in a `$NAME` / `${NAME...}` reference (an assignment,
 * `read NAME`, `printf -v NAME`, `for NAME in`, `declare NAME`, or only a mention), or in `${NAME=` / `${NAME:=`. Loose on purpose.
 * @param {string} line the whole command line the guard got
 * @returns {(name: string) => boolean} the test for one variable name, each name searched once
 */
export function namesWrittenIn(line) {
  const known = new Map();
  return (name) => {
    if (!known.has(name)) known.set(name, new RegExp(`(?<![\\w$]|\\$\\{)${name}(?!\\w)|\\$\\{${name}:?=`).test(line));
    return known.get(name);
  };
}

/**
 * The reasons of one command text that git or a git-run value runs, each distinct text checked once per command line; in another directory
 * it is checked once more with the directory unknown (null), which the rm and find rules read most strictly, and that answer is kept.
 * @param {string} text the command text
 * @param {{cwd: string|null, judged: Map<string, {cwd: string|null, reasons: string[]}>}} env the guard's env; cwd is where the text runs
 * @param {(text: string, env: object) => string[]} reasonsOf the guard's check of a command line
 * @returns {string[]} the reasons, empty when the text is fine
 */
export function judgeOnce(text, env, reasonsOf) {
  const earlier = env.judged.get(text);
  if (earlier !== undefined && (earlier.cwd === env.cwd || earlier.cwd === null)) return earlier.reasons;
  const cwd = earlier === undefined ? env.cwd : null;
  const reasons = reasonsOf(text, { ...env, cwd });
  env.judged.set(text, { cwd, reasons });
  return reasons;
}

/** The text git would run after one assignment; `NAME+=x` adds to the value the line set before, or to an unknown inherited one. */
const valueText = ([, name, append, value], vars) => (append === '' ? value : `${vars.has(name) ? vars.get(name) : `$${name}`}${value}`);

/** True when the value holds an expansion the guard does not resolve: `$(`, a backtick, `${..}` with an operator, `$1`, an unknown variable. */
function unreadable(text, env) {
  const resolves = (name) => (name === HOME ? !env.written(HOME) : env.vars.has(name));
  return EXPANSION.test(text.replace(REFERENCE, (whole, braced, bare) => (resolves(braced ?? bare) ? '' : whole)));
}

/** The reasons of one git-run value: none for one reference to a variable the line does not write, an ask when it cannot be read. */
function valueReasons(text, env, reasonsOf) {
  const reference = ONE_REFERENCE.exec(text);
  if (text.trim() === '' || (reference !== null && !env.written(reference[1] ?? reference[2]))) return [];
  if (unreadable(text, env)) return [GIT_UNREADABLE_REASON];
  return judgeOnce(text, env, reasonsOf).filter((reason) => !VARIABLE_COMMAND_REASONS.has(reason));
}

/**
 * Every reason the values of git-run variables assigned in one simple command give (see the header).
 * @param {string[]} words the command's words, the variables the line assigned before them substituted
 * @param {{cmd: string|undefined, args: string[], at: number}} parsed the command commandOf found in them (at: index of its word)
 * @param {{cwd: string|null, vars: Map<string, string>, written: (name: string) => boolean, judged: Map<string, object>}} env the guard's
 *   env for this command: the literal values the line assigned before it, the line's written names (namesWrittenIn) and the judgeOnce memo
 * @param {(text: string, env: object) => string[]} reasonsOf the guard's check of a command line
 * @returns {string[]} ask reasons, empty when every value is fine
 */
export function gitRunValueReasons(words, { cmd, args, at }, env, reasonsOf) {
  const assignments = [...words.slice(0, at + 1), ...(DECLARERS.has(cmd) ? args : [])].map((word) => ASSIGNMENT.exec(word));
  const values = assignments.filter((match) => match !== null && RUN_NAMES.has(match[1])).map((match) => valueText(match, env.vars));
  const defaults = [...words.join(' ').matchAll(DEFAULT_ASSIGNMENT)].filter(([, name]) => RUN_NAMES.has(name)).map(([, , value]) => value);
  return [...new Set([...values, ...defaults])].flatMap((text) => valueReasons(text, env, reasonsOf));
}
