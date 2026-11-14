// Purpose: the whole `check` job in one function so tests and the CLI share it: list files, run every check, and with
//   `changed` keep only what the change added; return the findings.
// Exports: runCheck({root, changed, base}).
// Invariants: reads files but never writes. Whole-tree mode (no `changed`) is an audit of everything. With `changed`:
//   header checks only on added files, config keys only when the change added them, and name, depth and README findings
//   only when the change created the file or folder (see added-only.mjs). Throws UsageError (bad allow-list, no git).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAllowLists } from './allow.mjs';
import { keepWhatChangeAdded } from './added-only.mjs';
import { configKind, findUncommentedKeys } from './config-comments.mjs';
import { isLockOrGenerated } from './exemptions.mjs';
import { changesSince, resolveBase } from './git-changes.mjs';
import { findMissingHeader } from './header-check.mjs';
import { findDeepNesting, findDumpingNames, findMissingReadmes, isSourceFile } from './structure-checks.mjs';
import { listFiles } from './walk.mjs';

const read = (root, path) => readFileSync(join(root, path), 'utf8');

/**
 * @param {{root: string, changed?: boolean, base?: string}} options
 * @returns {object[]} findings (see structure-checks.mjs for the shape)
 */
export function runCheck({ root, changed = false, base }) {
  const allowed = readAllowLists(root);
  const files = listFiles(root).filter((path) => !isLockOrGenerated(path));
  const changes = changed ? changesSince(root, resolveBase(root, base)) : null;

  const structure = [...findMissingReadmes(files), ...findDumpingNames(files, allowed), ...findDeepNesting(files)];
  const findings = changes ? keepWhatChangeAdded(structure, changes) : structure;
  for (const path of files) {
    if (changes && !changes.changed.has(path)) continue;
    if (isSourceFile(path) && (!changes || changes.added.has(path))) findings.push(...findMissingHeader(path, read(root, path)));
    if (configKind(path) === null) continue;
    const entry = changes?.changed.get(path);
    findings.push(...findUncommentedKeys(path, read(root, path), entry?.lines ?? null, entry?.removed ?? []));
  }
  return findings;
}
