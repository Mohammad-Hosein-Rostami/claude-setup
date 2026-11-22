// Which risk classes a change falls in (login/security, stored data, money, locking and parallel runs, the setup's own guards, very large
// changes: owner decision NC4, design section 3.6). A risky change gets one AI review before it lands; the classes come from the data file
// home/tools/done-check/risk-rules.json, so tuning is an edit of that file, not of code.
// Exports: riskClasses(scope, rules, extra) -> { class, file }[]; loadRiskRules(file) -> { rules, warning }; parseRiskRules(text) ->
//   rules (throws); DEFAULT_RISK_RULES; RISK_RULES_FILE.
// Rule file: { version: 1, classes: { <name>: { paths: [<regex source>, ...] } }, large: { lines, files } }. Each regex is matched, case
//   insensitively, against the repo-relative path with `/` separators and a space put between a lower and an upper case letter
//   (`sessionLock.ts` is read as `session lock.ts`), so `(^|[^a-z0-9])lock` finds a lock but not `block`. `checkout` and `ledger` are
//   not money words (`git checkout`, `stale-checkout` and the done-check's own ledger were false alarms of the old review tier).
// Invariants:
// - Only paths are read for the path classes: no file text, so nothing a writer wrote in a file can switch a class off.
// - A bad rule file never switches the review off: loadRiskRules returns the built-in defaults and a warning line (P12).
// - `large` is more than rules.large.lines changed lines or more than rules.large.files changed files. Lines are counted with git against
//   the base (the worktree compared with it, new files by their line count); without git or a base only the file count applies.
// - A class a lane adds by name (`extra`) is always in the result, with an empty file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { runGit } from '../../../hooks/lib/gated-folder.mjs';

/** The shipped rule file. */
export const RISK_RULES_FILE = new URL('../risk-rules.json', import.meta.url);

const MAX_RULE_FILE_BYTES = 64 * 1024;
const MAX_CLASSES = 20;
const MAX_PATTERNS_PER_CLASS = 100;
const MAX_PATTERN_CHARS = 300;
const CLASS_NAME = /^[a-z][a-z-]{0,19}$/;
const SIZE_CLASS = 'large'; // set by the size rule only
const COMMIT_HASH = /^[0-9a-f]{40}$/;
const PATHSPEC_CHUNK = 100; // paths per git call, far below the command line limit
const MAX_COUNTED_FILE_BYTES = 2 * 1024 * 1024;

/** The same rules as risk-rules.json, for a rule file that is missing or invalid. Keep the two equal when one changes. */
export const DEFAULT_RISK_RULES = Object.freeze({
  version: 1,
  classes: {
    security: { paths: ['auth', 'login', 'session', 'token', 'secret', 'credential', 'passw', 'crypto', 'permission', 'guard', 'sandbox', 'sanitiz', 'upload', 'webhook', 'oauth', 'jwt', 'cookie', 'csrf', 'cors'] },
    data: { paths: ['(^|/)(migrations?|prisma)/', '\\.sql$', 'schema\\.'] },
    money: { paths: ['payment', 'invoice', 'billing', 'refund', 'stripe', 'wallet'] },
    concurrency: { paths: ['(^|[^a-z0-9])(un)?lock(s|ed|ing|file)?([^a-z0-9]|$)', '(^|[^a-z0-9])(mutex|semaphore|queue|worker|flock)(es|s)?([^a-z0-9]|$)'] },
    gate: { paths: ['^home/hooks/', '^home/tools/(land-lane|road|done-check)/'] },
  },
  large: { lines: 400, files: 15 },
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

/**
 * Checks a parsed rule file and returns it. Every pattern must be a short string that compiles as a regular expression.
 * @param {string} text the file text (JSON)
 * @returns {{ version: 1, classes: Record<string, { paths: string[] }>, large: { lines: number, files: number } }} the rules
 * @throws {Error} the text is not JSON or breaks the schema above; the message names the first problem
 */
export function parseRiskRules(text) {
  const rules = JSON.parse(text);
  if (!isPlainObject(rules) || rules.version !== 1) throw new Error('risk rules: "version" must be 1');
  const names = isPlainObject(rules.classes) ? Object.keys(rules.classes) : null;
  if (names === null || names.length > MAX_CLASSES) throw new Error(`risk rules: "classes" must be an object of at most ${MAX_CLASSES} classes`);
  for (const name of names) {
    const { paths } = rules.classes[name] ?? {};
    if (!CLASS_NAME.test(name) || name === SIZE_CLASS) throw new Error(`risk rules: bad class name "${name}"`);
    if (!Array.isArray(paths) || paths.length > MAX_PATTERNS_PER_CLASS) throw new Error(`risk rules: "${name}.paths" must be a list of at most ${MAX_PATTERNS_PER_CLASS} patterns`);
    for (const pattern of paths) {
      if (typeof pattern !== 'string' || pattern === '' || pattern.length > MAX_PATTERN_CHARS) throw new Error(`risk rules: "${name}" has a pattern that is not a short string`);
      new RegExp(pattern); // throws a SyntaxError that names the pattern
    }
  }
  if (!isPositiveInteger(rules.large?.lines) || !isPositiveInteger(rules.large?.files)) throw new Error('risk rules: "large.lines" and "large.files" must be positive whole numbers');
  return rules;
}

/**
 * The rules of a rule file, or the built-in defaults and a warning when the file is missing, too big or invalid.
 * @param {URL|string} [file] the rule file (default: the shipped risk-rules.json)
 * @returns {{ rules: object, warning: string|null }} warning is one line for the owner, null when the file was fine
 */
export function loadRiskRules(file = RISK_RULES_FILE) {
  try {
    const text = file instanceof URL ? readFileSync(file, 'utf8') : readPlainFile(file, MAX_RULE_FILE_BYTES);
    if (text.length > MAX_RULE_FILE_BYTES) throw new Error('risk rules: file is too big');
    return { rules: parseRiskRules(text), warning: null };
  } catch (error) {
    return { rules: DEFAULT_RISK_RULES, warning: `risk rules not used, built-in defaults apply: ${String(error.message).split('\n')[0]}` };
  }
}

const compiledByRules = new WeakMap();
function compiled(rules) {
  if (!compiledByRules.has(rules)) {
    compiledByRules.set(rules, Object.entries(rules.classes).map(([name, { paths }]) => ({ name, patterns: paths.map((pattern) => new RegExp(pattern)) })));
  }
  return compiledByRules.get(rules);
}

const readable = (path) => path.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
const isSafeRelative = (path) => typeof path === 'string' && path !== '' && !path.startsWith('/') && !/^[a-z]:/i.test(path) && !path.split('/').includes('..');

/** Changed lines of `files` (added plus deleted) in tracked files, from `git diff --numstat` against the base. */
function trackedChangedLines(scope, files) {
  const base = COMMIT_HASH.test(scope.base ?? '') ? scope.base : 'HEAD';
  let total = 0;
  for (let from = 0; from < files.length; from += PATHSPEC_CHUNK) {
    const result = runGit(scope.top, ['--literal-pathspecs', 'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', base, '--', ...files.slice(from, from + PATHSPEC_CHUNK)]);
    if (result.status !== 0) continue; // git could not say (for example no such base): the file count still applies
    for (const entry of result.stdout.split('\0')) {
      const [added, deleted] = entry.split('\t');
      total += (Number(added) || 0) + (Number(deleted) || 0); // a binary file prints `-`: no lines
    }
  }
  return total;
}

/** Lines of the files git does not know yet (a new file counts all its lines). */
function untrackedLines(scope, files) {
  const result = runGit(scope.top, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...files]);
  if (result.status !== 0) return 0;
  let total = 0;
  for (const path of result.stdout.split('\0').filter(Boolean)) {
    try {
      const text = readPlainFile(join(scope.top, path), MAX_COUNTED_FILE_BYTES);
      total += text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch (error) {
      if (!error?.code) throw error; // a link, a FIFO, a file over the cap or a vanished file adds no lines
    }
  }
  return total;
}

function isLarge(scope, limits) {
  if (scope.files.length > limits.files) return true;
  if (!scope.git || !scope.top || scope.files.length === 0) return false;
  const files = scope.files.filter(isSafeRelative);
  return trackedChangedLines(scope, files) + untrackedLines(scope, files) > limits.lines;
}

/**
 * The risk classes of a change.
 * @param {import('./contract.mjs').Scope} scope the changed files and the base they are compared with
 * @param {{ classes: Record<string, { paths: string[] }>, large: { lines: number, files: number } }} rules from loadRiskRules (already checked)
 * @param {string[]} [extra] class names the lane's spec adds (for example `audit`); each is always in the result
 * @returns {{ class: string, file: string }[]} one entry per class and matching file, in the order of the rule file; `large` and the
 *   extra classes have an empty file (they belong to the whole change); an empty list is an ordinary change
 */
export function riskClasses(scope, rules, extra = []) {
  const found = [];
  for (const { name, patterns } of compiled(rules)) {
    for (const file of scope.files) {
      const text = readable(file);
      if (patterns.some((pattern) => pattern.test(text))) found.push({ class: name, file });
    }
  }
  if (isLarge(scope, rules.large)) found.push({ class: SIZE_CLASS, file: '' });
  for (const name of extra) if (!found.some((entry) => entry.class === name && entry.file === '')) found.push({ class: name, file: '' });
  return found;
}
