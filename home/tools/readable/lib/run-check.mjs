// Purpose: the whole `check` job in one function so tests and the CLI share it: list files, run every check, narrow to
//   the changed files when asked, return the findings.
// Exports: runCheck({root, changed, base}).
// Invariants: reads files but never writes; with `changed` set, a finding is kept only when one of its `files` changed
//   (config keys only when their own line changed); throws GitError when git cannot answer.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllowList } from './allow.mjs';
import { configKind, findUncommentedKeys } from './config-comments.mjs';
import { changedSince, resolveBase } from './git-changes.mjs';
import { findMissingHeader } from './header-check.mjs';
import { findDeepNesting, findDumpingNames, findMissingReadmes, isSourceFile } from './structure-checks.mjs';
import { listFiles } from './walk.mjs';

const ALLOW_FILE = '.readable.json';
const read = (root, path) => readFileSync(join(root, path), 'utf8');

/**
 * @param {{root: string, changed?: boolean, base?: string}} options
 * @returns {object[]} findings (see structure-checks.mjs for the shape)
 */
export function runCheck({ root, changed = false, base }) {
  const files = listFiles(root);
  const allowText = existsSync(join(root, ALLOW_FILE)) ? read(root, ALLOW_FILE) : null;
  const { allowed, problems } = parseAllowList(allowText);
  const changes = changed ? changedSince(root, resolveBase(root, base)) : null;
  const isChanged = (path) => changes === null || changes.has(path);

  const findings = [
    ...findMissingReadmes(files), ...findDumpingNames(files, allowed), ...findDeepNesting(files),
  ].filter((finding) => finding.files.some(isChanged));
  for (const path of files.filter(isChanged)) {
    if (isSourceFile(path)) findings.push(...findMissingHeader(path, read(root, path)));
    if (configKind(path) !== null) findings.push(...findUncommentedKeys(path, read(root, path), changes?.get(path) ?? null));
  }
  for (const message of problems) {
    findings.push({ path: ALLOW_FILE, line: 1, rule: 'C32', check: 'allow-list', files: [ALLOW_FILE], message, fix: 'fix the entry in .readable.json.' });
  }
  return findings;
}
