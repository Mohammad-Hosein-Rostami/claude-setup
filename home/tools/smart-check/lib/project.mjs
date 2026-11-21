// Purpose: what the smart check needs to know about the repo a change lives in: which checks it has (tsconfig, project references,
//   lint, build, tests), how many files import a UI file (round 2, 9.1 shared scope), whether this is a Figma or pixel-perfect job,
//   and, in a repo with scripts/affected-tests.mjs, the affected tests of the change.
// Exports: projectFacts(top), consumerCounter(git), figmaJobOf(top, scope), affectedOf(top, paths).
// Invariants: read-only; every subprocess has a timeout; any failure gives the cautious answer (a check present, no consumers known,
//   no affected list) so the rules never skip a check because a read failed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from '../../../hooks/lib/typecheck-plan.mjs';

const AFFECTED_SCRIPT = join('scripts', 'affected-tests.mjs');
const AFFECTED_TIMEOUT_MS = 20_000;
const MAX_CONSUMER_LOOKUPS = 10; // UI files per change whose importers are counted; the rest count as local
const ESLINT_FILES = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml'];
const MATRIX_FILES = ['matrix.json', join('ui-coverage', 'matrix.json'), join('.ui-coverage', 'matrix.json'), join('ui', 'matrix.json')];
const FIGMA_WORDS = /\b(figma|pixel[- ]?perfect)\b/i;

/**
 * The checks this repo has.
 * @param {string} top the repo top
 * @returns {{tsconfig: boolean, references: boolean, lint: boolean, build: boolean, tests: boolean, affectedScript: boolean,
 *   scripts: Object<string, string>, testRunner: 'node'|'vitest'|'jest'|'script'|null}}
 */
export function projectFacts(top) {
  const pkg = readJsonFile(join(top, 'package.json')) ?? {};
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const tsconfig = readJsonFile(join(top, 'tsconfig.json'));
  const affectedScript = existsSync(join(top, AFFECTED_SCRIPT));
  let testRunner = null;
  if (deps.vitest) testRunner = 'vitest';
  else if (deps.jest) testRunner = 'jest';
  else if (affectedScript) testRunner = 'node';
  else if (typeof scripts.test === 'string' && !/no test specified/.test(scripts.test)) testRunner = 'script';
  return {
    tsconfig: tsconfig !== null || existsSync(join(top, 'tsconfig.json')), references: Array.isArray(tsconfig?.references) && tsconfig.references.length > 0,
    lint: typeof scripts.lint === 'string' || ESLINT_FILES.some((name) => existsSync(join(top, name))), build: typeof scripts.build === 'string',
    tests: testRunner !== null, affectedScript, scripts, testRunner,
  };
}

/**
 * A counter of the files that import a UI file, by its file stem (`Button.tsx` -> "/Button'" or "/Button\"" in an import).
 * @param {{run: (args: string[]) => {ok: boolean, out: string}}} git from gitOf
 * @returns {(path: string) => number} 0 when unknown or past MAX_CONSUMER_LOOKUPS
 */
export function consumerCounter(git) {
  let lookups = 0;
  return (path) => {
    const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    if (!stem || stem === 'index' || lookups >= MAX_CONSUMER_LOOKUPS) return 0;
    lookups += 1;
    const { out } = git.run(['grep', '-l', '-I', '-F', '-e', `/${stem}'`, '-e', `/${stem}"`, '-e', `/${stem}.`, '--']);
    return out.split('\n').filter((line) => line && line !== path).length;
  };
}

/** True when the job is a Figma or pixel-perfect one: the owner's /check scope says so, or the repo's UI matrix has a Figma part. */
export function figmaJobOf(top, scope) {
  if (FIGMA_WORDS.test(scope ?? '') || process.env.SMART_CHECK_FIGMA === '1') return true;
  return MATRIX_FILES.some((name) => {
    const matrix = readJsonFile(join(top, name));
    return matrix !== null && typeof matrix === 'object' && 'figma' in matrix;
  });
}

/** The number of test files in tests/ (the suite size scripts/affected-tests.mjs picks from). */
function suiteSize(top) {
  try {
    return readdirSync(join(top, 'tests')).filter((name) => name.endsWith('.test.mjs')).length;
  } catch {
    return 0;
  }
}

/**
 * The affected tests of `paths`, from the repo's own scripts/affected-tests.mjs (`--list`), with the share of the suite they are.
 * @param {string} top the repo top
 * @param {string[]} paths repo-relative changed paths that still exist
 * @returns {{tests: string[], share: number} | null} null when the repo has no such script or it failed
 */
export function affectedOf(top, paths) {
  if (!existsSync(join(top, AFFECTED_SCRIPT)) || paths.length === 0) return null;
  const result = spawnSync(process.execPath, [AFFECTED_SCRIPT, ...paths, '--list'], { cwd: top, encoding: 'utf8', timeout: AFFECTED_TIMEOUT_MS, windowsHide: true });
  if (result.status !== 0) return null;
  const tests = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const total = suiteSize(top);
  return { tests, share: total ? tests.length / total : 0 };
}
