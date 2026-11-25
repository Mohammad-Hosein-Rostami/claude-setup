// Tests of the land ledger's one line per real fast-forward (home/tools/land/land.mjs, ledger.mjs): a re-run after a clean-up stop
// writes no second line even when main moved on before it, and a real fast-forward of a second base checkout to a sha the ledger
// already holds for the same branch name is still recorded (or warned about), never dropped without a word.
// Every repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs) and every child gets its own temp HOME, so
// the ledger goes to <HOME>/.claude/state/land/ there and never to the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
const LANE = 'lane/x';
const RELEASE = 'release'; // a second base branch, checked out in its own worktree of the same repository
const REPO_KEY_HEX = 16; // the design's <repo-key>: the first 16 hex of the sha256 of the real git common dir
const NESTED_FOLDER = 'scratch'; // ignored by the repo's .gitignore, so git status of the worktree stays empty
const UNWRITTEN_WARNING = /was not written/; // the wording of land's ledger warning (ledger.mjs appendLandEntry)

/** Runs land.mjs with `args` from `cwd`, with `home` as HOME and USERPROFILE (where the ledger goes). */
const landWith = (home, args, cwd) =>
  spawnSync(process.execPath, [LAND, ...args], { cwd, encoding: 'utf8', env: { ...CLEAN_ENV, HOME: home, USERPROFILE: home } });

const makeHome = () => realpathSync(makeTempDir('land-ledger-home-'));
const headOf = (dir) => git(dir, 'rev-parse', 'HEAD');

/** The non-empty lines of the ledger of `repo` under `home`, parsed; [] when there is no file. */
function ledgerEntries(home, repo) {
  const commonDir = realpathSync.native(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const key = createHash('sha256').update(commonDir).digest('hex').slice(0, REPO_KEY_HEX);
  const file = join(home, '.claude', 'state', 'land', `${key}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

const laneEntries = (home, repo) => ledgerEntries(home, repo).filter((entry) => entry.branch === LANE);

test('a re-run after a clean-up stop writes no second ledger line when main moved on before it', () => {
  const repo = makeRepo();
  commit(repo, '.gitignore', `${NESTED_FOLDER}/\n`);
  const folder = addWorktree(repo, 'plain-lane', LANE);
  const laneTip = commit(folder, 'lane.txt');
  const nested = join(folder, NESTED_FOLDER);
  mkdirSync(nested);
  git(nested, 'init', '-q', '-b', 'main');
  commit(nested, 'patch.txt', 'my patch to the dependency\n');
  assert.equal(git(folder, 'status', '--porcelain'), '', 'precondition: the nested repository is invisible to the lane');
  const home = makeHome();

  const first = landWith(home, [LANE, '--repo', repo], repo);
  assert.equal(first.status, 1, first.stdout);
  assert.match(first.stderr, new RegExp(`${NESTED_FOLDER}.+may hold the only copy of its commits`), first.stderr);
  assert.equal(headOf(repo), laneTip, 'the fast-forward happened before the clean-up stopped');
  assert.equal(laneEntries(home, repo).length, 1, 'the first run wrote its line');

  // main moves on before the re-run, so the re-run rebases lane/x onto the new main and lands at a sha no line holds yet
  const movedMain = commit(repo, 'other.txt');
  renameSync(nested, join(makeTempDir('land-ledger-moved-'), NESTED_FOLDER));
  const second = landWith(home, [LANE, '--repo', repo], repo);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(headOf(repo), movedMain, 'the re-run fast-forwarded nothing');
  const entries = laneEntries(home, repo);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(entries[0].to, laneTip);
});

test('a real fast-forward of a second base checkout to a sha already in the ledger is recorded or warned about', () => {
  const repo = makeRepo();
  const release = addWorktree(repo, 'release-checkout', RELEASE);
  const home = makeHome();
  const laneTip = commit(addWorktree(repo, 'first-lane', LANE), 'lane.txt');
  assert.equal(landWith(home, [LANE, '--repo', repo], repo).status, 0);
  assert.equal(headOf(repo), laneTip);
  assert.equal(laneEntries(home, repo).length, 1, 'the landing on main wrote its line');

  // the same branch name made again at the same tip and landed on the release checkout: release really moves
  git(repo, 'branch', LANE, laneTip);
  const releaseBefore = headOf(release);
  const second = landWith(home, [LANE, '--repo', release], release);
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(releaseBefore, laneTip, 'precondition: release was behind the lane');
  assert.equal(headOf(release), laneTip, 'release fast-forwarded to the lane tip');
  // the brief accepts either fix: a second line for the release landing, or a warning that its line was not written
  if (UNWRITTEN_WARNING.test(second.stderr)) return;
  const entries = laneEntries(home, repo);
  assert.equal(entries.length, 2, `no second line and no warning on stderr (${JSON.stringify(second.stderr)}): ${JSON.stringify(entries)}`);
  assert.equal(entries[1].to, laneTip);
});
