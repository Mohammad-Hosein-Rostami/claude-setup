// Shared fixtures for the review-tier CLI tests: a throw-away lane branch, the CLI run in it, and a prior findings file.
// Exports: CLI, lane(), priorFile(text).
// Invariants: every repo and file lives in its own temp folder (makeTempDir); the CLI's log goes next to the repo, never to ~/.claude.
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

export const CLI = fileURLToPath(new URL('../home/tools/review-tier/review-tier.mjs', import.meta.url));

/**
 * A repo on a new branch `lane` plus a log file in its own temp folder.
 * @returns {{dir: string, log: string, tier: Function, json: Function, write: Function}} `tier(...args)` runs the CLI there, `json(...args)`
 *   parses its `--json` output, `write(path, text)` commits one file and returns the new full sha.
 */
export function lane() {
  const dir = makeRepo();
  const log = join(dir, '..', 'review-tier.jsonl');
  const tier = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log } });
  const json = (...args) => JSON.parse(tier(...args, '--json').stdout);
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    git(dir, 'add', '--', path);
    git(dir, 'commit', '-q', '-m', `edit ${path}`);
    return git(dir, 'rev-parse', 'HEAD');
  };
  git(dir, 'checkout', '-q', '-b', 'lane');
  return { dir, log, tier, json, write };
}

/** The review report of the previous round, in its own temp folder (a plain path: no symlink, no space). */
export function priorFile(text = '| F1 | should-fix | src/run.mjs:2 | spawn without a shell option | pass shell: false |\n') {
  const path = join(realpathSync(makeTempDir('review-tier-prior-')), 'findings-round1.md');
  writeFileSync(path, text);
  return path;
}
