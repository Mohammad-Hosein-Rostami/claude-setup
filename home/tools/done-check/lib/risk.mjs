// Which risk classes a change falls in (login/security, stored data, money, locking and parallel runs, the setup's own guards, very large
// changes: owner decision NC4, design section 3.6). A risky change gets one AI review before it lands; the classes come from the data file
// home/tools/done-check/risk-rules.json, so tuning is an edit of that file, not of code.
// Exports: riskClasses(scope, rules, extra) -> Promise<{ class, file }[]>; loadRiskRules(file) -> { rules, warning }; parseRiskRules(text) ->
//   rules (throws); DEFAULT_RISK_RULES; RISK_RULES_FILE.
// Rule file, version 2: { version: 2, leftOut?: [<regex>], keep?: [<regex>], classes: { <name>: { paths?, words? } }, large: { lines,
//   files } }; each list holds regex sources. A path is read in lower case with `/` separators (a `\` counts as one) and a space put
//   where a name changes case: `sessionLock.ts` is read as `session lock.ts`, `JWTService.ts` as `jwt service.ts`, `OAuth2Client` as
//   `o auth 2 client` (a letter before a digit splits too). Then:
//   - `paths` match anywhere in the whole path (`^home/hooks/` for the setup's own gates, `(^|[^a-z0-9])lock` for a lock but not `block`);
//   - `words` match one whole word of a folder or file name (a name splits at those spaces and at each character that is not a letter or
//     digit): `useSession.ts`, `session-store.ts`, `RouteGuard.tsx` and `src/auth/` hold a security word; `tokenizer.ts`, `author.ts`
//     and `guardian.ts` do not (a word never matches part of a word).
//   `checkout` and `ledger` are not money words (`git checkout`, `stale-checkout` and the done-check's own ledger were false alarms of
//   the old review tier). Version 1 ({ version: 1, classes: { <name>: { paths } }, large }) still reads: its `paths` match as above and
//   nothing is left out.
// Invariants:
// - A `leftOut` file is in no class and is not counted for `large`, unless `keep` names it: a test by its own name (`*.test.ts`, not by
//   its folder, so `src/test/authServer.ts` is code) and docs (`.md`, `.txt`; `.mdx` is code). They do not change what runs, and a
//   weakened test has its own check (lib/test-diff.mjs). `keep` holds the texts that steer every run (agent files, SKILL.md, the rules,
//   settings): they are the setup's own guards (`gate`) and count like code. Every other file is matched on its path.
// - A file whose changed lines (scope.mjs `changedLines`) are all comments or blank lines is left out (a comment edit to billing code is
//   not a money change); any doubt (no git base, a deleted file, a pure deletion, an unreadable file or git error, a Vue file) keeps the
//   class. The file text is read only for that test, and it can only switch a class off for
//   changed lines that hold no code at all (lib/code-lines.mjs).
// - A bad rule file never switches the review off: loadRiskRules returns the built-in defaults and a warning line (P12).
// - `large` is more than rules.large.lines changed lines or more than rules.large.files changed files, both without left-out files.
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
const LIST_KEYS = ['paths', 'words'];
const STEERING_TEXTS = ['^home/agents/[^/]*\\.md$', '(^|/)\\.claude/agents/[^/]*\\.md$', '^home/skills/.*/skill\\.md$', '^home/claude\\.md$', '^home/lead[^/]*\\.md$',
  '^home/rules/[^/]*\\.md$', '^settings/[^/]*\\.json$']; // never left out, and `gate` (paths are read in lower case)
const COMMIT_HASH = /^[0-9a-f]{40}$/;
const PATHSPEC_CHUNK = 100; // paths per git call, far below the command line limit
const MAX_COUNTED_FILE_BYTES = 2 * 1024 * 1024;
const SCRIPT_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i; // the languages lib/code-lines.mjs reads; a .vue file also holds markup

/** The same rules as risk-rules.json, for a rule file that is missing or invalid. Keep the two equal when one changes. */
export const DEFAULT_RISK_RULES = Object.freeze({
  version: 2,
  leftOut: ['\\.(test|spec)\\.[cm]?[jt]sx?$', '\\.(md|markdown|txt|rst|adoc)$'],
  keep: STEERING_TEXTS,
  classes: {
    security: {
      words: ['auth', 'authn', 'authz', 'authenticat(e|ed|es|ion|or)', 'authoriz(e|ed|es|ation|er)', 'oauth', 'login', 'logins', 'logout', 'signin', 'sessions?', 'tokens?',
        'secrets?', 'jwts?', 'csrf', 'xsrf', 'cors', 'credentials?', 'passwords?', 'passwd', 'keychains?', 'crypto', 'cookies?', 'permissions?', 'guards?', 'sandbox(es)?',
        'uploads?', 'webhooks?', 'accounts?', 'sanitiz(e|ed|es|er|ers|ing|ation)'],
    },
    data: { paths: ['(^|/)(migrations?|prisma)/', '\\.sql$', 'schema\\.'] },
    money: { paths: ['payment', 'invoice', 'billing', 'refund', 'stripe', 'wallet'] },
    concurrency: { paths: ['(^|[^a-z0-9])(un)?lock(s|ed|ing|file)?([^a-z0-9]|$)', '(^|[^a-z0-9])(mutex|semaphore|queue|worker|flock)(es|s)?([^a-z0-9]|$)'] },
    gate: { paths: ['^home/hooks/', '^home/tools/(land-lane|road|done-check)/', ...STEERING_TEXTS] },
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
 * @returns {{ version: 1|2, leftOut?: string[], keep?: string[], classes: Record<string, { paths?: string[], words?: string[] }>,
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
  for (const key of ['leftOut', 'keep']) if (rules.version !== 1 && rules[key] !== undefined) checkPatterns(key, rules[key]);
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
/** The rules with every pattern compiled once: `leftOut`, `keep` and, per class, its paths (anywhere) and words (whole). */
function compiled(rules) {
  if (!compiledByRules.has(rules)) {
    const modern = rules.version !== 1; // a version 1 class has only `paths`, and nothing is left out
    compiledByRules.set(rules, {
      leftOut: modern ? anywhere(rules.leftOut) : [],
      keep: modern ? anywhere(rules.keep) : [],
      classes: Object.entries(rules.classes).map(([name, entry]) => ({ name, paths: anywhere(entry.paths), words: modern ? whole(entry.words) : [] })),
    });
  }
  return compiledByRules.get(rules);
}

/** The path in the form every pattern reads (see the file header): `/` separators, a space at each change of case, lower case. */
const readable = (path) => path
  .replaceAll('\\', '/')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // sessionLock -> session Lock
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // JWTService -> JWT Service
  .replace(/([a-zA-Z])([0-9])/g, '$1 $2') // OAuth2 -> OAuth 2
  .toLowerCase();

/** True when the readable path `text` is in the compiled class `riskClass`: a path pattern matches, or a word of a name is a rule word. */
function inClass(riskClass, text) {
  if (riskClass.paths.some((pattern) => pattern.test(text))) return true;
  const words = text.split(/[^a-z0-9]+/).filter(Boolean); // `/` is not a letter or digit, so this splits the folder and file names too
  return words.some((word) => riskClass.words.some((pattern) => pattern.test(word)));
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
 *   changed only in comments or blank lines, or that `leftOut` names and `keep` does not, has none; `large` and the extra classes have an empty file (they
 *   belong to the whole change); an empty list is an ordinary change
 */
export async function riskClasses(scope, rules, extra = []) {
  const found = [];
  const commentOnly = new Map();
  const { leftOut, keep, classes } = compiled(rules);
  const isLeftOut = (text) => leftOut.some((pattern) => pattern.test(text)) && !keep.some((pattern) => pattern.test(text));
  const counted = scope.files.filter((file) => !isLeftOut(readable(file)));
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
