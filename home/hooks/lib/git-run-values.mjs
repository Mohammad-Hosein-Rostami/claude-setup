// The values git runs from a variable or a config entry. Variables (lib/git-runs.mjs COMMAND_ENV: GIT_EDITOR, GIT_PAGER, GIT_SSH_COMMAND,
// EDITOR ...) are read wherever a command line assigns one: in front of a command (`X=1 cmd`, `env X=1 cmd`), as a statement, after
// export|declare|typeset|local|readonly (any options) and in `${NAME:=value}`; git need not follow in the line. lib/git-runs.mjs sends the
// config values and variables it finds for one git command through valueReasons too.
// Exports: gitRunValueReasons(words, parsed, env, reasonsOf); valueReasons(text, env, reasonsOf, target); judgeOnce(text, env, reasonsOf);
// lineFacts(line) -> {writes, alone, placeholders}.
// A value is judged as a nested command, a variable in it as an opaque argument. It asks GIT_UNREADABLE_REASON when the guard cannot read
// what runs: a substitution (`$(`, a backtick, `${...}` with an operator), the placeholder xargs, parallel or find fills in, a variable the
// line writes that the guard could not resolve, or a variable as a command word (other than $HOME and the ones the guard resolves).
// Exceptions: a value that is exactly one reference to a variable the line does not write (`"$EDITOR"`; one reference in the raw text too,
// so `"$V"x` is not `$Vx`), and `${NAME:-literal}` (`-`, `:-`, `=`, `:=`) of such a variable, whose literal is judged. A git-run variable
// that read, printf -v, mapfile, readarray, getopts, for or select writes asks the same. Both parsers lose a value given as an unquoted
// backtick: lib/raw-risk.mjs asks for that one, and a variable assigned from one stays unknown (lib/rm-paths.mjs newScope), so it asks here.
// Pure, no I/O. judgeOnce checks each distinct text at most twice per command line (in its directory, then once with the directory
// unknown), and lineFacts reads the line once, so a value that many git commands or assignments repeat costs one check.
import { commandOf } from './command-of.mjs';
import { COMMAND_ENV, GIT_UNREADABLE_REASON } from './git-runs.mjs';
import { DECLARERS } from './rm-paths.mjs';
import { SPLIT_VARIABLE_REASON, VARIABLE_COMMAND_REASON } from './shell-hazards.mjs';
import { tokenize } from './shell-words.mjs';

const RUN_NAMES = new Set(COMMAND_ENV);
const ASSIGNMENT = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/;
const DEFAULT_ASSIGNMENT = /\$\{([A-Za-z_]\w*):?=([^}]*)\}/g; // assigns when the variable is unset (`:=` also when it is empty)
const ONE_REFERENCE = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/;
const DEFAULT_VALUE = /^\$\{([A-Za-z_]\w*):?[-=]([^}$`]*)\}$/; // the variable's value, or the literal when it is unset
const REFERENCE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
// what the guard cannot read: `$(`, a backtick, `${...}` with an operator, or a `$` that ends the value (the parsers end a value there when
// they split off an unquoted `$(...)`)
const SUBSTITUTION = /`|\$\(|\$\{(?![A-Za-z_]\w*\})|\$$/;
// a name that stands outside a `$NAME` / `${NAME...}` reference (an assignment, `read NAME`, `printf -v NAME`, `for NAME`), or `${NAME:=`
const NAME_WRITE = /(?<![\w$]|\$\{)([A-Za-z_]\w*)(?!\w)|\$\{([A-Za-z_]\w*):?=/g;
// a reference that is a whole word of the raw line: after `=` or a space, maybe in double quotes, before a word end
const ALONE_REFERENCE = /(?:^|[=\s])"?\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})"?(?=[\s;&|()<>}]|$)/g;
// a write whose variable name is itself a variable (`printf -v "$N"`, `export "$N=x"`): it may write any name
const UNKNOWN_TARGET = /\bprintf\s+(?:-\S+\s+)*-v\s*["']?\$|\b(?:read|mapfile|readarray|getopts|export|declare|typeset|local|readonly)\b(?:\s+-\S+)*\s+["']?\$/;
const FILLS_PLACEHOLDERS = /(?:^|[\s;&|(])(?:xargs|parallel)(?=\s)/;
const REPLACE_OPTION = /(?:^|\s)(?:-I\s*|--replace=|-i)([^\s;&|]+)/g; // xargs and parallel `-I R`, `-IR`, `--replace=R`, xargs `-iR`
const PLACEHOLDER = '{}'; // find -exec, parallel, xargs -i
const OUT_OF_SIGHT_WRITERS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'for', 'select']); // their words name what they write
const HOME = 'HOME';
// a variable as a value's command word asks above; inside, the judge's own variable-command reason would only repeat that
const VARIABLE_COMMAND_REASONS = new Set([VARIABLE_COMMAND_REASON, SPLIT_VARIABLE_REASON]);

/**
 * What the whole command line says about the values git runs, read once: which names it may write, which references stand alone in
 * the raw text, and the placeholders xargs, parallel and find fill in. Loose on purpose: a name that is only mentioned counts as written.
 * @param {string} line the whole command line the guard got
 * @returns {{writes: (name: string, target?: string) => boolean, alone: (name: string) => boolean, placeholders: string[]}} writes is
 *   true when the line may write `name` other than by the one assignment to `target` the value belongs to (`EDITOR="${EDITOR:-vim}"` reads
 *   the inherited value), always after a write to a name that is itself a variable
 */
export function lineFacts(line) {
  const counts = new Map();
  for (const [, bare, defaulted] of line.matchAll(NAME_WRITE)) counts.set(bare ?? defaulted, (counts.get(bare ?? defaulted) ?? 0) + 1);
  const alone = new Set([...line.matchAll(ALONE_REFERENCE)].map(([, bare, braced]) => bare ?? braced));
  const anyName = UNKNOWN_TARGET.test(line);
  const replaced = FILLS_PLACEHOLDERS.test(line) ? [...line.matchAll(REPLACE_OPTION)].map(([, text]) => text.replace(/["']/g, '')) : [];
  return {
    writes: (name, target) => anyName || (counts.get(name) ?? 0) > (name === target ? 1 : 0),
    alone: (name) => alone.has(name),
    placeholders: [PLACEHOLDER, ...replaced.filter((text) => text !== '')],
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
  const reasons = reasonsOf(text, cwd === env.cwd ? env : { ...env, cwd });
  env.judged.set(text, { cwd, reasons });
  return reasons;
}

/** True when a command in the value starts with a variable the guard does not resolve ($HOME and the ones it knows name a program file). */
function variableCommandWord(text, env) {
  if (!text.includes('$')) return false; // no reference: skip the tokenizing (a line of many values stays fast)
  const resolves =(name) => (name === HOME || env.vars.has(name)) && !env.line.writes(name);
  return tokenize(text).segs.some((seg) => {
    const word = seg[commandOf(seg).at] ?? '';
    return word.replace(REFERENCE, (whole, braced, bare) => (resolves(braced ?? bare) ? '' : whole)).includes('$');
  });
}

/**
 * The reasons of one value git runs, a git-run variable's or a config entry's (see the header).
 * @param {string} text the value as the parsers read it, the variables the line assigned before it substituted
 * @param {{cwd: string|null, vars: Map<string, string>, line: ReturnType<typeof lineFacts>, judged: Map<string, object>}} env the guard's env
 * @param {(text: string, env: object) => string[]} reasonsOf the guard's check of a command line
 * @param {string} [target] the variable the value is assigned to, if any: that assignment is not a write of what the value reads
 * @returns {string[]} ask reasons, empty when the value is fine
 */
export function valueReasons(text, env, reasonsOf, target) {
  const unwritten = (name) => !env.line.writes(name, target);
  const [, braced, bare] = ONE_REFERENCE.exec(text) ?? [];
  if (text.trim() === '' || ((braced ?? bare) !== undefined && unwritten(braced ?? bare) && env.line.alone(braced ?? bare))) return [];
  const fallback = DEFAULT_VALUE.exec(text);
  if (fallback !== null && unwritten(fallback[1])) return valueReasons(fallback[2], env, reasonsOf, target);
  if (SUBSTITUTION.test(text) || env.line.placeholders.some((mark) => text.includes(mark))) return [GIT_UNREADABLE_REASON];
  const written = [...text.matchAll(REFERENCE)].some(([, inBraces, plain]) => !unwritten(inBraces ?? plain)); // assigned, not resolved
  if (written || variableCommandWord(text, env)) return [GIT_UNREADABLE_REASON];
  return judgeOnce(text, env, reasonsOf).filter((reason) => !VARIABLE_COMMAND_REASONS.has(reason));
}

/** The text git would run after one assignment; `NAME+=x` adds to the value the line set before, or to an unknown inherited one. */
const valueText = ([, name, append, value], vars) => (append === '' ? value : `${vars.has(name) ? vars.get(name) : `$${name}`}${value}`);

/** The variables `printf -v NAME` and `printf -vNAME` write. */
const printfTargets = (args) => args.flatMap((word, i) => (word === '-v' ? [args[i + 1]] : word.startsWith('-v') ? [word.slice(2)] : []));

/** True when read, printf -v, mapfile, readarray, getopts, for or select writes a variable git runs: its value is out of sight. */
function writesOutOfSight(cmd, args) {
  const targets = cmd === 'printf' ? printfTargets(args) : OUT_OF_SIGHT_WRITERS.has(cmd) ? args : [];
  return targets.some((name) => RUN_NAMES.has(name));
}

/**
 * Every reason the values of git-run variables assigned in one simple command give (see the header).
 * @param {string[]} words the command's words, the variables the line assigned before them substituted
 * @param {{cmd: string|undefined, args: string[], at: number}} parsed the command commandOf found in them (at: index of its word)
 * @param {{cwd: string|null, vars: Map<string, string>, line: ReturnType<typeof lineFacts>, judged: Map<string, object>}} env the guard's
 *   env for this command: the literal values the line assigned before it, the line's facts (lineFacts) and the judgeOnce memo
 * @param {(text: string, env: object) => string[]} reasonsOf the guard's check of a command line
 * @returns {string[]} ask reasons, empty when every value is fine
 */
export function gitRunValueReasons(words, { cmd, args, at }, env, reasonsOf) {
  if (writesOutOfSight(cmd, args)) return [GIT_UNREADABLE_REASON];
  if (!words.some((word) => word.includes('='))) return []; // no assignment and no `${NAME:=value}` (most commands, and fast)
  const assignments = [...words.slice(0, at + 1), ...(DECLARERS.has(cmd) ? args : [])].map((word) => ASSIGNMENT.exec(word));
  const values = assignments.filter((match) => match !== null && RUN_NAMES.has(match[1])).map((match) => [match[1], valueText(match, env.vars)]);
  const defaults = [...words.join(' ').matchAll(DEFAULT_ASSIGNMENT)].filter(([, name]) => RUN_NAMES.has(name)).map(([, name, text]) => [name, text]);
  const distinct = new Map([...values, ...defaults].map(([target, text]) => [`${target}=${text}`, [target, text]]));
  return [...distinct.values()].flatMap(([target, text]) => valueReasons(text, env, reasonsOf, target));
}
