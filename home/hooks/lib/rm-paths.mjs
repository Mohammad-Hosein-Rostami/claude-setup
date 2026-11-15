// Path rules for `rm -r` and `cd`: is a target inside the project or a temp dir, and which variables hold what.
// Exports: checkRm(args, {cwd, project, vars}) -> reason | undefined; newScope(cwd, project) -> {vars, assigned};
// trackAssignments(scope, tokens, nextTokens); substituteKnownWords(tokens, scope); nativePath, isUnder, sameFile, expandHome; RECURSIVE_FLAG;
// withoutRedirects(args) (also read by lib/git-runs.mjs); DECLARERS (also read by lib/git-run-values.mjs).
// Variables are tracked in order within one command line and the LAST assignment wins (`D=$(mktemp -d); D=/etc` means /etc).
// A literal value is used as is, `VAR=$(mktemp -d)` (default location; the tokenizer turns it into MKTEMP_WORD, also with a path
// suffix `$(mktemp -d)/..` and in backticks) stands for one directory inside the temp dir, `D+=x` appends, and any
// other value is unknown. `..` is resolved lexically after substitution, so `$D/..` is outside the mktemp directory.
// Brace expansion in targets (`{/,x}`) is expanded first; one that cannot be listed asks.
// `$(git rev-parse --show-toplevel)` counts as the project root from a directory inside the project (`rm -rf "$(git rev-parse --show-toplevel)/dist"`).
// Only a recursive rm asks about an unknown or outside target; `rm -f x` of one file is not judged here.
// Invariants: pure apart from reading homedir()/tmpdir(); never touches the file system.
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { expandBraces } from './braces.mjs';
import { GIT_TOPLEVEL_WORD, MKTEMP_WORD, QUOTED_MARK, flagsOf } from './shell-words.mjs';
import { destructive } from './verdict.mjs';

const SAFE_TEMP_ROOTS = ['/tmp', '/private/tmp', tmpdir()];
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const GIT_BASH_DRIVE_ROOT = /^\/[a-zA-Z]$/;
const REDIRECT_START = /^(\d*>>?|\d*<|&>>?)/;
const REDIRECT_OPERATOR_ONLY = /^(\d*>>?|\d*<{1,2}|&>>?)$/;
const VAR_PREFIX = /^\$\{?(\w+)\}?(?=\/|$)/;
const MKTEMP_NAME = MKTEMP_WORD.slice(1);
const ANY_VAR = /\$\{(\w+)\}|\$(\w+)/g;
const ASSIGNMENT = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/;
const MKTEMP_DIR = 'mktemp-variable';
export const DECLARERS = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);
/** An rm option that deletes recursively: `-r`, `-R`, a cluster holding one (`-rf`, `-fR`), or `--recursive`. */
export const RECURSIVE_FLAG = /^--recursive$|^-[a-zA-Z]*[rR]/;

/** Git Bash paths (`/c/Users/x`) -> `C:/Users/x` on Windows; unchanged elsewhere. */
export const nativePath = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : p);

export const isUnder = (root, target) => {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
export const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** `~`, `~/x`, `$HOME`, `${HOME}` -> the home directory. Other words are unchanged. */
export const expandHome = (target) => target.replace(HOME_PREFIX, homedir());

/** $HOME, `/`, a drive root (`C:\`, `/c/`) are never "the project": a session started there would allow rm -r anywhere. */
function isBroadRoot(project) {
  const path = resolve(nativePath(project));
  return sameFile(path, parse(path).root) || sameFile(path, resolve(homedir())) || GIT_BASH_DRIVE_ROOT.test(path);
}

/**
 * Variable state for one command line: `vars` maps names to known values (`$TMPDIR`, `$CLAUDE_PROJECT_DIR`, `$PWD` when the
 * directory is known, then every literal assignment seen so far); `assigned` holds the names assigned in the command itself.
 */
export function newScope(cwd, project) {
  const vars = new Map([['TMPDIR', tmpdir()], ['CLAUDE_PROJECT_DIR', project], [MKTEMP_NAME, mktempDir()]]);
  if (cwd !== null) vars.set('PWD', cwd);
  return { vars, assigned: new Set() };
}

export const expandVars = (target, vars) => target.replace(VAR_PREFIX, (whole, name) => (vars.has(name) ? vars.get(name) : whole));
const mktempDir = () => join(tmpdir(), MKTEMP_DIR);
const isMktempValue = (value) => typeof value === 'string' && value.startsWith(mktempDir());

/** The value a `NAME=value` word gives, or undefined when it cannot be known (`$(...)` other than the mktemp stand-in). */
function valueOf(raw, vars) {
  if (raw === '$' || raw === '`') return undefined; // a bare `$(`/backtick: the value is another command's output
  const value = expandVars(expandHome(raw), vars);
  return /[$`]/.test(value) ? undefined : value;
}

/**
 * Updates `vars` for assignments in one segment (a bare `NAME=x` segment or `export NAME=x`), `unset`, `read`. Call after the
 * segment was checked. Names that become unknown are removed, so a later `$NAME` target is unknown.
 * @param {{vars: Map<string, string>, assigned: Set<string>}} scope tracked values (modified)
 * @param {string[]} tokens words of this segment
 */
export function trackAssignments({ vars, assigned }, tokens) {
  const words = DECLARERS.has(tokens[0]) ? tokens.slice(1) : tokens;
  if (['unset', 'read'].includes(tokens[0])) {
    for (const name of tokens.slice(1).filter((w) => !w.startsWith('-'))) vars.delete(name);
    return;
  }
  const assignments = words.map((w) => ASSIGNMENT.exec(w));
  if (assignments.length === 0 || assignments.some((m) => m === null)) return; // a command with arguments, not assignments
  for (const [, name, append, raw] of assignments) {
    assigned.add(name);
    const added = valueOf(raw, vars);
    const value = append && added !== undefined ? (vars.has(name) ? vars.get(name) + added : undefined) : added; // `D+=x` extends the old value
    if (value === undefined) vars.delete(name);
    else vars.set(name, value);
  }
}

/**
 * Replaces `$NAME` / `${NAME}` inside words by the literal value assigned earlier in this command line, so `X=rm; $X -rf /x`
 * reads `rm -rf /x` and `v=r; ${v}m -rf /x` too. Names never assigned here, and mktemp directories, stay as they are.
 * @param {string[]} tokens words of one segment
 * @param {{vars: Map<string, string>, assigned: Set<string>}} scope
 */
export function substituteKnownWords(tokens, { vars, assigned }) {
  const replace = (whole, braced, plain) => {
    const name = braced ?? plain;
    return assigned.has(name) && vars.has(name) && !isMktempValue(vars.get(name)) ? vars.get(name) : whole;
  };
  return tokens.map((word) => word.replace(ANY_VAR, replace));
}

/** `$(git rev-parse --show-toplevel)` is the project root, but only from a directory inside the project (elsewhere it is unknown). */
function expandToplevel(target, cwd, project) {
  if (target !== GIT_TOPLEVEL_WORD && !target.startsWith(`${GIT_TOPLEVEL_WORD}/`)) return target;
  if (cwd === null) return target;
  const root = resolve(nativePath(project));
  const here = resolve(nativePath(cwd));
  return sameFile(here, root) || isUnder(root, here) ? root + target.slice(GIT_TOPLEVEL_WORD.length) : target;
}

/** `cwd` is null when an earlier `cd` could not be resolved: then only absolute targets can be judged. */
function insideProject(rawTarget, cwd, project, vars) {
  const target = expandVars(expandHome(expandToplevel(rawTarget, cwd, project)), vars);
  if (target.startsWith('~') || target.includes('$')) return false;
  const native = nativePath(target);
  if (cwd === null && !isAbsolute(native)) return false;
  const abs = resolve(cwd ?? project, native);
  // `$D/..` and `$D/../x` leave the unique directory mktemp made, so they only count as safe while they stay inside it
  if (target.startsWith(mktempDir())) return abs === mktempDir() || isUnder(mktempDir(), abs);
  return (!isBroadRoot(project) && isUnder(project, abs)) || SAFE_TEMP_ROOTS.some((root) => isUnder(root, abs));
}

/** Drops redirections (`2>&1`, `> file`) so they are not mistaken for rm targets. */
export function withoutRedirects(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (!REDIRECT_START.test(args[i])) out.push(args[i]);
    else if (REDIRECT_OPERATOR_ONLY.test(args[i])) i++; // the operator stands alone: its target is the next word
  }
  return out;
}

/**
 * @param {string[]} args words after `rm`
 * @returns {string | undefined} ask reason when a recursive rm targets something outside the project and the temp dirs (or an unknown variable)
 */
export function checkRm(args, { cwd, project, vars }) {
  if (!flagsOf(args).some((f) => RECURSIVE_FLAG.test(f))) return undefined;
  const words = withoutRedirects(args).filter((a) => !a.startsWith('-'));
  if (words.some((word) => expandBraces(word) === null)) return destructive('rm -r with a brace expansion that cannot be listed (check the targets by hand)');
  const outside = words.flatMap(expandBraces).find((t) => !insideProject(t, cwd, project, vars));
  return outside === undefined ? undefined : destructive(`rm -r outside the project (${outside.replace(QUOTED_MARK, '')})`);
}
