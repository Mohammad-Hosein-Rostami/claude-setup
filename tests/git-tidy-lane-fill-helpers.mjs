// Fixtures for the clone-fill tests of the lane pool (git-tidy-lane-fill, -lane-claim-fill, -lane-deps, -lane-snapshot .test.mjs).
// Exports: NEEDS_CLONE, jsRepo, addEmptySlot, filesOf, waitForFile.
// Invariants: every repo is a cs-test- temp repo (git-tidy-helpers.mjs makeRepo); a test that needs a clone fill takes NEEDS_CLONE, so
//   it runs where the temp folder can be cloned (APFS; Linux with reflinks) and the fill file's own tests do not hide behind it.
import { existsSync, mkdirSync, realpathSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { cloneSupport } from '../home/tools/git-tidy/lib/lane-fill.mjs';
import { commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { poolPath, snapshot } from './git-tidy-lane-pool-helpers.mjs';

const WAIT_MS = 60_000;
const GIT_FOLDER_PREFIX = '.git/';

/** A repo whose .gitignore ignores what a JS project's does (node_modules, dist, .env) plus the folders a lane never clones. */
export function jsRepo() {
  const dir = makeRepo();
  commit(dir, '.gitignore', 'node_modules/\ndist/\n.env\n.husky/_/\n.claude/\npersonal/\nvenv/\nHANDOFF*.md\n');
  return dir;
}

const probeRepo = jsRepo();
const probePool = join(realpathSync(probeRepo), '.claude', 'worktrees');
mkdirSync(probePool, { recursive: true });
const probe = cloneSupport(probeRepo, probePool, {}); // no env: the tests' own children never see the owner's GIT_TIDY_LANE_FILL either

/** Test options of a case that is about the clone fill: it is skipped where cloneSupport says the temp folder cannot be cloned. */
export const NEEDS_CLONE = { skip: probe.mode !== 'clone' && `no file clones here (${probe.why})` };

/** `git worktree add --no-checkout --detach` of `<repo>/.claude/worktrees/lane-<number>` at `sha`, as a claim's first step does; returns the folder. */
export function addEmptySlot(repo, number, sha) {
  const folder = poolPath(repo, number);
  mkdirSync(dirname(folder), { recursive: true });
  git(repo, 'worktree', 'add', '--quiet', '--no-checkout', '--detach', '--', folder, sha);
  return folder;
}

/** Every file and link of `folder` as `path -> sha256`, without git's own folder, for a before/after compare of a working copy. */
export function filesOf(folder) {
  return new Map([...snapshot(folder)].filter(([path]) => path !== '.git' && !path.startsWith(GIT_FOLDER_PREFIX)));
}

/**
 * Resolves when `file` exists: it watches the folder first, then looks, so a file made before the first event is not missed.
 * @param {string} file absolute path; its folder must exist
 * @returns {Promise<void>} rejects after a minute, naming the file
 */
export function waitForFile(file) {
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => { clearTimeout(timer); watcher.close(); settle(value); };
    const timer = setTimeout(() => finish(reject, new Error(`${file} did not appear within ${WAIT_MS / 1000} s`)), WAIT_MS);
    const watcher = watch(dirname(file), () => { if (existsSync(file)) finish(resolve); });
    if (existsSync(file)) finish(resolve);
  });
}
