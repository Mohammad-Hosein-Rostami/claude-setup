// Shared fixtures for the readable tests: build a project folder from {path: text}, run the CLI and git in it.
// Exports: HEADER, project, readable, git, commitAll, CLEAN_ENV.
// Invariants: every GIT_* variable is removed from the child environment. Under the pre-commit hook git sets GIT_DIR and
//   GIT_INDEX_FILE, and a child git would then act on the repo being committed instead of the fixture.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const CLI = fileURLToPath(new URL('../home/tools/readable/readable.mjs', import.meta.url));
export const HEADER = '// Purpose: fixture.\n';
export const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const GIT_ENV = { ...CLEAN_ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

/** Builds a temp folder from {path: text} and returns its path. */
export function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'readable-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Writes more files into an existing project (an edit when the path exists). */
export function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** Runs the CLI with a clean git environment; `env` adds variables on top. */
export const readable = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...env } });

export function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV });
  assert.equal(result.status, 0, result.stderr);
}

/** `git init` on branch main and one commit holding everything. */
export function commitAll(root) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
}
