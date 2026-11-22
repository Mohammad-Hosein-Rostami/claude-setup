// Which risk classes a change falls in (login/security, stored data, money, locking and parallel runs, the setup's own guards, very large
// changes: owner decision NC4, design section 3.6). A risky change gets one AI review before it lands; the classes come from the data file
// home/tools/done-check/risk-rules.json, so tuning is an edit of that file, not of code.
// Exports: riskClasses(scope, rules, extra) -> Promise<{ class, file }[]>; loadRiskRules(file) -> { rules, warning }; parseRiskRules(text) ->
//   rules (throws); DEFAULT_RISK_RULES; RISK_RULES_FILE.
// Rule file, version 2: { version: 2, leftOut?: [<regex>], classes: { <name>: { paths?, segments?, words? } }, large: { lines, files } };
//   each list holds regex sources. A path is read in lower case with `/` separators (a `\` counts as one) and a space put between a
//   lower and an upper case letter (`sessionLock.ts` is read as `session lock.ts`). Then:
//   - `paths` match anywhere in the whole path (`^home/hooks/` for the setup's own gates, `(^|[^a-z0-9])lock` for a lock but not `block`);
//   - `segments` match a whole folder or file name, the file name cut at its first dot (`src/auth/`, `lib/session.ts`, `token.json`):
//     for words that also name harmless things (a Claude session, an LLM token, the Bash guard), so `session-notes.mjs`, `token-view/`
//     and `agent-model-guard.mjs` are not security (the hooks are `gate` by their path);
//   - `words` match one word of a folder or file name (a name splits at each character that is not a letter or digit): `auth-service.ts`.
//   A segment or word pattern matches the whole name or word, never a part of it. `checkout` and `ledger` are not money words (`git
//   checkout`, `stale-checkout` and the done-check's own ledger were false alarms of the old review tier).
//   Version 1 ({ version: 1, classes: { <name>: { paths } }, large }) still reads: its `paths` match as above and nothing is left out.
// Invariants:
// - A `leftOut` file (tests, docs) is in no path class and is not counted for `large`: it does not change what runs, and a weakened
//   test has its own check (lib/test-diff.mjs). Every other file is matched on its path. A file whose changed lines (scope.mjs
//   `changedLines`) are all comments or blank lines is left out (a comment edit to billing code is not a money change); any doubt (no git base, a deleted file, a pure deletion, an unreadable
//   file or git error, a Vue file) keeps the class. The file text is read only for that test, and it can only switch a class off for
//   changed lines that hold no code at all (lib/code-lines.mjs).
// - A bad rule file never switches the review off: loadRiskRules returns the built-in defaults and a warning line (P12).
// - `large` is more than rules.large.lines changed lines or more than rules.large.files changed files, both without `leftOut` files.
//   Lines are counted with git against the base (the worktree compared with it, new files by their line count); without git or a base
//   only the file count applies.
// - A class a lane adds by name (`extra`) is always in the result, with an empty file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { runGit } from '../../../hooks/lib/gated-folder.mjs';
import { linesWithCode } from './code-lines.mjs';
import { changedLines } from './scope.mjs';

/** The shipped rule file. */
export const RISK_RULES_FILE = new URL('../risk-rules.json', import.meta.url);

const MAX_RULE_FILE_BYTES = 64 * 1024;
const MAX_CLASSES = 20;
const MAX_PATTERNS_PER_CLASS = 100;
const MAX_PATTERN_CHARS = 300;
const CLASS_NAME = /^[a-z][a-z-]{0,19}$/;
const SIZE_CLASS = 'large'; // set by the size rule only
const RULE_VERSIONS = [1, 2];
const LIST_KEYS = ['paths', 'segments', 'words'];
const COMMIT_HASH = /^[0-9a-f]{40}$/;
const PATHSPEC_CHUNK = 100; // paths per git call, far below the command line limit
const MAX_COUNTED_FILE_BYTES = 2 * 1024 * 1024;
const SCRIPT_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i; // the languages lib/code-lines.mjs reads; a .vue file also holds markup

/** The same rules as risk-rules.json, for a rule file that is missing or invalid. Keep the two equal when one changes. */
export const DEFAULT_RISK_RULES = Object.freeze({
  version: 2,
  leftOut: ['(^|/)(tests?|__tests__)/', '\\.(test|spec)\\.[^/]+$', '\\.(md|mdx|markdown|txt|rst|adoc)$'],
  classes: {
    security: {
      segments: ['sessions?', 'tokens?', 'secrets?', 'guards?', 'permissions?', 'sandbox(es)?', 'uploads?', 'accounts?'],
      words: ['auth', 'authn', 'authz', 'authenticat(e|ed|es|ion|or)', 'authoriz(e|ed|es|ation|er)', 'oauth2?', 'login', 'logins', 'logout', 'signin', 'jwts?', 'csrf', 'xsrf',
        'cors', 'credentials?', 'passwords?', 'passwd', 'keychains?', 'crypto', 'cookies?', 'webhooks?', 'sanitiz(e|ed|es|er|ers|ing|ation)'],
    },
    data: { paths: ['(^|/)(migrations?|prisma)/', '\\.sql$', 'schema\\.'] },
    money: { paths: ['payment', 'invoice', 'billing', 'refund', 'stripe', 'wallet'] },
    concurrency: { paths: ['(^|[^a-z0-9])(un)?lock(s|ed|ing|file)?([^a-z0-9]|$)', '(^|[^a-z0-9])(mutex|semaphore|queue|worker|flock)(es|s)?([^a-z0-9]|$)'] },
    gate: { paths: ['^home/hooks/', '^home/tools/(land-lane|road|done-check)/'] },
  },
  large: { lines: 400, files: 15 },
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

/** Throws unless `list` is a list of at most MAX_PATTERNS_PER_CLASS short strings that compile as regular expressions. */
function checkPatterns(label, list) {
  if (!Array.isArray(list) || list.length > MAX_PATTERNS_PER_CLASS) throw new Error(`risk rules: "${label}" must be a list of at most ${MAX_PATTERNS_PER_CLASS} patterns`);
  for (const pattern of list) {
    if (typeof pattern !== 'string' || pattern === '' || pattern.length > MAX_PATTERN_CHARS) throw new Error(`risk rules: "${label}" has a pattern that is not a short string`);
    new RegExp(pattern); // throws a SyntaxError that names the pattern
  }
}

/** The pattern lists of one class: version 1 knows only `paths`; version 2 needs one of LIST_KEYS and no other key. */
function patternListsOf(version, name, entry) {
  if (!isPlainObject(entry)) throw new Error(`risk rules: class "${name}" must be an object`);
  if (version === 1) return ['paths'];
  const keys = Object.keys(entry);
  const unknown = keys.find((key) => !LIST_KEYS.includes(key));
  if (unknown !== undefined) throw new Error(`risk rules: "${name}" has an unknown key "${unknown}" (known: ${LIST_KEYS.join(', ')})`);
  if (keys.length === 0) throw new Error(`risk rules: "${name}" needs at least one of ${LIST_KEYS.join(', ')}`);
  return keys;
}

/**
 * Checks a parsed rule file (version 1 or 2, see the file header) and returns it. Every pattern must be a short string that compiles as
 * a regular expression.
 * @param {string} text the file text (JSON)
 * @returns {{ version: 1|2, leftOut?: string[], classes: Record<string, { paths?: string[], segments?: string[], words?: string[] }>,
 *   large: { lines: number, files: number } }} the rules
 * @throws {Error} the text is not JSON or breaks the schema above; the message names the first problem
 */
export function parseRiskRules(text) {
  const rules = JSON.parse(text);
  if (!isPlainObject(rules) || !RULE_VERSIONS.includes(rules.version)) throw new Error(`risk rules: "version" must be ${RULE_VERSIONS.join(' or ')}`);
  const names = isPlainObject(rules.classes) ? Object.keys(rules.classes) : null;
  if (names === null || names.length > MAX_CLASSES) throw new Error(`risk rules: "classes" must be an object of at most ${MAX_CLASSES} classes`);
  for (const name of names) {
    if (!CLASS_NAME.test(name) || name === SIZE_CLASS) throw new Error(`risk rules: bad class name "${name}"`);
    for (const key of patternListsOf(rules.version, name, rules.classes[name])) checkPatterns(`${name}.${key}`, rules.classes[name][key]);
  }
  if (rules.version !== 1 && rules.leftOut !== undefined) checkPatterns('leftOut', rules.leftOut);
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

const anywhere = (sources = []) => sources.map((source) => new RegExp(source));
const whole = (sources = []) => sources.map((source) => new RegExp(`^(?:${source})$`));

const compiledByRules = new WeakMap();
/** The rules with every pattern compiled once: `leftOut` and, per class, its paths (anywhere), segments and words (whole). */
function compiled(rules) {
  if (!compiledByRules.has(rules)) {
    const modern = rules.version !== 1; // a version 1 class has only `paths`, and nothing is left out
    compiledByRules.set(rules, {
      leftOut: modern ? anywhere(rules.leftOut) : [],
      classes: Object.entries(rules.classes).map(([name, entry]) => ({
        name,
        paths: anywhere(entry.paths),
        segments: modern ? whole(entry.segments) : [],
        words: modern ? whole(entry.words) : [],
      })),
    });
  }
  return compiledByRules.get(rules);
}

const readable = (path) => path.replaceAll('\\', '/').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

/** True when the readable path `text` is in the compiled class `riskClass` (see the file header for the three kinds of pattern). */
function inClass(riskClass, text) {
  if (riskClass.paths.some((pattern) => pattern.test(text))) return true;
  return text.split('/').some((name) => {
    const segment = name.replace(/^\.+/, '').split('.')[0];
    const words = name.split(/[^a-z0-9]+/).filter(Boolean);
    return riskClass.segments.some((pattern) => pattern.test(segment)) || words.some((word) => riskClass.words.some((pattern) => pattern.test(word)));
  });
}

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

/** True when `counted` (the scope's files that are not left out) holds more files or changed lines than `limits` allow. */
function isLarge(scope, limits, counted) {
  if (counted.length > limits.files) return true;
  if (!scope.git || !scope.top || counted.length === 0) return false;
  const files = counted.filter(isSafeRelative);
  return trackedChangedLines(scope, files) + untrackedLines(scope, files) > limits.lines;
}

/** True when `file` changed only in comments or blank lines against the base; false whenever that cannot be shown. */
async function changedOnlyComments(scope, file) {
  if (!scope.git || !scope.top || !COMMIT_HASH.test(scope.base ?? '') || !isSafeRelative(file) || !SCRIPT_FILE.test(file)) return false;
  try {
    const ranges = await changedLines(scope.top, scope.base, file);
    if (ranges.length === 0) return false; // a deletion, an unchanged file or a file git does not list: the class stays
    const codeLines = linesWithCode(readPlainFile(join(scope.top, file), MAX_COUNTED_FILE_BYTES));
    return ranges.every(([start, end]) => Array.from({ length: end - start + 1 }, (_, offset) => start + offset).every((line) => !codeLines.has(line)));
  } catch {
    return false; // git or the file could not be read: say nothing about the lines and keep the class (a needless review costs a run, a miss costs a defect)
  }
}

/**
 * The risk classes of a change.
 * @param {import('./contract.mjs').Scope} scope the changed files and the base they are compared with
 * @param {object} rules from loadRiskRules or parseRiskRules (already checked; version 1 or 2)
 * @param {string[]} [extra] class names the lane's spec adds (for example `audit`); each is always in the result
 * @returns {Promise<{ class: string, file: string }[]>} one entry per class and matching file, in the order of the rule file; a file that
 *   changed only in comments or blank lines, or that `leftOut` names, has none; `large` and the extra classes have an empty file (they
 *   belong to the whole change); an empty list is an ordinary change
 */
export async function riskClasses(scope, rules, extra = []) {
  const found = [];
  const commentOnly = new Map();
  const { leftOut, classes } = compiled(rules);
  const counted = scope.files.filter((file) => !leftOut.some((pattern) => pattern.test(readable(file))));
  for (const riskClass of classes) {
    for (const file of counted) {
      if (!inClass(riskClass, readable(file))) continue;
      if (!commentOnly.has(file)) commentOnly.set(file, await changedOnlyComments(scope, file));
      if (!commentOnly.get(file)) found.push({ class: riskClass.name, file });
    }
  }
  if (isLarge(scope, rules.large, counted)) found.push({ class: SIZE_CLASS, file: '' });
  for (const name of extra) if (!found.some((entry) => entry.class === name && entry.file === '')) found.push({ class: name, file: '' });
  return found;
}
