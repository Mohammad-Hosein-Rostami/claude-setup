// Purpose: list the added lines of a diff that weaken a check: skip, only, todo, an ignore comment, a loosened number, a removed test.
// Exports: weakenedChecks(files), rewordedChecks(files), COMMIT_BLOCKING_KINDS.
// Invariants: pure; reads only test files and test, lint and type config (a source file may say `skip` for its own reasons);
//   returns {path, line, kind} only, never a line's text (like every review-tier output). A non-empty list blocks the waiver.
//   The repo's pre-commit hook (scripts/test-integrity.mjs) also blocks a commit on every kind in COMMIT_BLOCKING_KINDS (C13, C29);
//   `bound` cannot tell a weaker number from a stronger one, so it stays a reviewer finding. A reworded test or assertion
//   (rewordedChecks) passes only with its reason in the commit body (the commit-msg hook).
import { CHECK_FILE_PATH } from '../tiers.mjs';

const TEST_FILE_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./;
const ADDED_PATTERNS = [
  { kind: 'ignore', pattern: /ts-ignore|ts-nocheck|eslint-disable/ },
  { kind: 'only', pattern: /\.only\(|\bonly:\s*true/ },
  { kind: 'skip', pattern: /\.skip\(|\bskip:\s*(?!false\b)\S|\bx(?:it|describe|test)\(|\.fixme\(/ },
  { kind: 'todo', pattern: /\.todo\(|\btodo:\s*(?!false\b)\S/ },
];
const TEST_DECLARATION = /\b(test|it|describe)\(/;
const ASSERTION = /\bassert[.(]|\bexpect\(/;

/** The kinds that block a commit in this repo: a deleted or skipped test, `.only`, an ignore comment (never `bound`). */
export const COMMIT_BLOCKING_KINDS = new Set(['removed-test', 'removed-assert', 'only', 'skip', 'todo', 'ignore']);

const isCheckFile = (path) => TEST_FILE_PATH.test(path.toLowerCase()) || CHECK_FILE_PATH.test(path.toLowerCase());
const withNumbersMasked = (text) => text.replace(/\d+/g, '#');

/** Removed lines that count for `pattern` beyond the added lines that count for it (a rewritten test is not a removed one). */
function unmatchedRemoved(file, pattern) {
  const added = file.added.filter(({ text }) => pattern.test(text)).length;
  return file.removed.filter(({ text }) => pattern.test(text)).slice(added);
}

/** `bound`: an added line equal to a removed one except for its numbers (a limit, count or timeout was changed). */
function changedBounds(file) {
  const unused = [...file.removed];
  const found = [];
  for (const { line, text } of file.added) {
    const index = unused.findIndex((old) => old.text !== text && withNumbersMasked(old.text) === withNumbersMasked(text));
    if (index === -1) continue;
    unused.splice(index, 1);
    found.push({ line, kind: 'bound' });
  }
  return found;
}

/**
 * Test declarations and assertions whose wording changed: a removed line of that kind matched by an added one with other text
 * (a renamed test, a changed expected value). Not a weakening by itself, but it needs a reason in the commit body.
 * @param {{path: string, added: {line: number, text: string}[], removed: {line: number, text: string}[]}[]} files
 * @returns {{path: string, line: number, kind: 'reworded-test'|'reworded-assert'}[]}
 */
export function rewordedChecks(files) {
  const found = [];
  for (const file of files.filter(({ path }) => isCheckFile(path))) {
    for (const [kind, pattern] of [['reworded-test', TEST_DECLARATION], ['reworded-assert', ASSERTION]]) {
      const removedTexts = new Set(file.removed.filter(({ text }) => pattern.test(text)).map(({ text }) => text.trim()));
      const added = file.added.filter(({ text }) => pattern.test(text) && !removedTexts.has(text.trim()));
      const removedCount = [...removedTexts].filter((text) => !file.added.some((line) => line.text.trim() === text)).length;
      found.push(...added.slice(0, removedCount).map(({ line }) => ({ path: file.path, line, kind })));
    }
  }
  return found;
}

/**
 * @param {{path: string, added: {line: number, text: string}[], removed: {line: number, text: string}[]}[]} files
 * @returns {{path: string, line: number, kind: 'only'|'skip'|'todo'|'ignore'|'bound'|'removed-test'|'removed-assert'}[]}
 */
export function weakenedChecks(files) {
  const found = [];
  for (const file of files.filter(({ path }) => isCheckFile(path))) {
    const entries = [];
    for (const { line, text } of file.added) {
      for (const { kind, pattern } of ADDED_PATTERNS) if (pattern.test(text)) entries.push({ line, kind });
    }
    entries.push(...changedBounds(file));
    for (const { line } of unmatchedRemoved(file, TEST_DECLARATION)) entries.push({ line, kind: 'removed-test' });
    for (const { line } of unmatchedRemoved(file, ASSERTION)) entries.push({ line, kind: 'removed-assert' });
    found.push(...entries.map((entry) => ({ path: file.path, ...entry })));
  }
  return found;
}
