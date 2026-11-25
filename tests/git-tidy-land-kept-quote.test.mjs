// Test of the `lane release` step that `git-tidy land` prints for a pool folder it could not free (feature land-detach): pasted into
// a shell it must free the folder even when the repository path holds a space or a quote. The CLI runs on throw-away repos in the OS
// temp folder, every child with its own temp HOME, USERPROFILE and TMPDIR and a fake session id.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CLEAN_ENV, CLI, commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { adminDir, claim, laneEnv, poolPath } from './git-tidy-lane-pool-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const PRINTED_TOOL = 'node ~/.claude/tools/git-tidy/git-tidy.mjs';
const FREE_IT_WITH = 'free it with: ';
const LANE_BRANCH = 'lane/h';
const UNQUOTED_PATH_REFUSAL = 'unknown argument'; // what lane release says when the shell split the repository path at its space

/** A single-quoted shell word (a quote inside is written as '\''). */
const shellQuote = (word) => `'${word.replaceAll("'", "'\\''")}'`;

/** A repo with one commit at `<temp>/<name>` (a copy of makeRepo's, which holds no path of its own folder): its real path. */
function repoNamed(name) {
  const fresh = makeRepo();
  const dir = join(realpathSync(makeTempDir('land-kept-quote-')), name);
  cpSync(fresh, dir, { recursive: true });
  return dir;
}

/** The `git worktree list --porcelain` block of `folder`, as lines. */
function worktreeBlock(repo, folder) {
  const block = git(repo, 'worktree', 'list', '--porcelain').split('\n\n').find((entry) => entry.split('\n')[0] === `worktree ${folder}`);
  assert.notEqual(block, undefined, `${folder} is not a worktree of ${repo}`);
  return block.split('\n');
}

/** Lands lane/h of a repo named `name` while an index.lock keeps the switch from freeing its folder; the lock is gone on return. */
function keptLand(name) {
  const repo = repoNamed(name);
  const env = laneEnv();
  env.TMPDIR = makeTempDir('land-kept-quote-tmp-');
  const claimed = claim(repo, LANE_BRANCH, git(repo, 'rev-parse', 'HEAD'), env);
  assert.equal(claimed.status, 0, claimed.stderr);
  const folder = poolPath(repo, 1);
  const tip = commit(folder, 'lane.txt');
  const indexLock = join(adminDir(folder), 'index.lock');
  writeFileSync(indexLock, '');

  const landed = tidy(['land', LANE_BRANCH, repo, '--tip', tip], { env });
  rmSync(indexLock, { force: true });

  const notFreed = lines(landed).filter((line) => line.startsWith('lane folder ') && line.includes(FREE_IT_WITH));
  assert.equal(notFreed.length, 1, landed.stdout + landed.stderr);
  return { repo, env, folder, step: notFreed[0].slice(notFreed[0].indexOf(FREE_IT_WITH) + FREE_IT_WITH.length) };
}

/** Runs the printed `step` in sh, with the printed tool path swapped for this checkout's CLI. */
function pasteStep(step, env) {
  assert.ok(step.startsWith(PRINTED_TOOL), `the printed step is a git-tidy command: ${step}`);
  const command = `${shellQuote(process.execPath)} ${shellQuote(CLI)}${step.slice(PRINTED_TOOL.length)}`;
  return spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...CLEAN_ENV, ...env } });
}

for (const [what, name] of [['a space', 'my proj x'], ['a single quote', "it's proj"]]) {
  test(`the lane release step printed for a kept folder frees it when pasted into a shell, for a repository path with ${what}`, () => {
    const { repo, env, folder, step } = keptLand(name);
    const block = worktreeBlock(repo, folder);
    assert.ok(block.includes(`branch refs/heads/${LANE_BRANCH}`), 'the folder is still on its branch');

    const released = pasteStep(step, env);

    assert.equal(released.status, 0, `the pasted step failed (an exit 2 with "${UNQUOTED_PATH_REFUSAL}" means its paths are not shell-quoted): ${step}\n${released.stdout}${released.stderr}`);
    const freed = worktreeBlock(repo, folder);
    assert.ok(freed.includes('detached'), freed.join('\n'));
    assert.ok(!freed.some((line) => line.startsWith('locked')), freed.join('\n'));
  });
}
