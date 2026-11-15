// Purpose: readers for GitHub workflow files (working-directory, cache-dependency-path, local `uses: ./...`) and for
//   CODEOWNERS (patterns without wildcards).
// Exports: readWorkflow, readCodeowners.
// Invariants: existence is asked of the real file system, never of the scan's file list (which skips build folders). Workflow paths are relative to the folder that holds `.github`; values with `${{` are skipped; a miss under a build output folder is the hint `ci-path?`; a glob in
//   cache-dependency-path must match something. A CODEOWNERS pattern with a slash at the start or middle is relative to
//   that folder; one without (`legacy.md`, `docs/`) may match at any depth.
import { basename, dirname } from 'node:path';
import { globMatches } from './glob.mjs';
import { hasGlobChars, resolveRef, underBuildOutput } from './ref-path.mjs';
import { scanYaml } from './yaml-lines.mjs';

const WORKFLOW_KEYS = new Set(['working-directory', 'cache-dependency-path']);

function workflowValue(entry) {
  if (entry.value === null || entry.value.includes('${{') || entry.value.startsWith('!')) return null;
  const isListItemOfPaths = entry.key === null && entry.isItem && entry.parents.at(-1) === 'cache-dependency-path';
  if (isListItemOfPaths || WORKFLOW_KEYS.has(entry.key)) return entry.value;
  return entry.key === 'uses' && entry.value.startsWith('./') ? entry.value : null;
}

/**
 * @param {{abs: string, text: string}} file a file under .github/workflows
 * @param {{disk: import('./disk.mjs').Disk}} context
 */
export function readWorkflow(file, { disk }) {
  const repoRoot = dirname(dirname(dirname(file.abs)));
  return scanYaml(file.text)
    .map((entry) => ({ entry, value: workflowValue(entry) }))
    .filter(({ value }) => value !== null)
    .filter(({ value }) => !(hasGlobChars(value) ? globMatches(disk, repoRoot, value) : disk.exists(resolveRef(repoRoot, value))))
    .map(({ entry, value }) => ({ kind: underBuildOutput(value) ? 'ci-path?' : 'ci-path', value, line: entry.line }));
}

function patternExists(pattern, repoRoot, context) {
  const name = pattern.replace(/\/$/, '');
  const anchored = pattern.startsWith('/') || name.includes('/');
  return anchored ? context.disk.exists(resolveRef(repoRoot, name.replace(/^\//, ''))) : context.disk.allNames().has(name);
}

/**
 * @param {{abs: string, text: string}} file CODEOWNERS
 * @param {{disk: import('./disk.mjs').Disk}} context
 */
export function readCodeowners(file, context) {
  const parent = dirname(file.abs);
  const repoRoot = ['.github', 'docs'].includes(basename(parent)) ? dirname(parent) : parent;
  return file.text.split(/\r?\n/).flatMap((text, index) => {
    const pattern = text.trim().split(/\s+/)[0];
    if (pattern === '' || pattern.startsWith('#') || /[*?[!\\]/.test(pattern)) return [];
    return patternExists(pattern, repoRoot, context) ? [] : [{ kind: 'codeowners-path', value: pattern, line: index + 1 }];
  });
}
