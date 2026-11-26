// Purpose: the test branches `board tick` names (branch-drift plan, tick-3): every `test/*` branch tess-write made that is not
//   landed yet, so none is left behind once its fix or feature landed.
// Exports: testBranches(repo, mainSha, { lanes, tidy, plan }) -> TestBranch[].
// Invariants: reads git only (one for-each-ref, one rev-list per test branch, one worktree list); a repository with no `test/*`
//   branch costs no rev-list. A branch is only shown, never landed or deleted here. Left out: a branch a pool lane holds (it has
//   its `lane` line), a `tidy` subject (prune's) and a branch with no commit of its own that no folder holds (merged; prune's).
import { gitText } from '../../git-tidy/lib/git.mjs';
import { listWorktrees } from '../../git-tidy/lib/repo.mjs';
import { pieceBranch } from './tick-features.mjs';

const HEADS = 'refs/heads/';
const TEST_BRANCHES = `${HEADS}test/`; // tess-write's prefix (home/agents/tess.md)

/**
 * @typedef {{ branch: string, commits: number, folder: string | null, piece: string | null }} TestBranch
 *   `commits` beyond main, `folder` the worktree that holds it (null when none), `piece` the plan piece built on it (its `branch`)
 */

/**
 * The `test/*` branches not landed on main.
 * @param {{ dir: string }} repo openRepo's result (git runs there)
 * @param {string} mainSha main's tip, the base the commits are counted from
 * @param {{ lanes: { branch: string }[], tidy: { subject: string }[], plan: { pieces: object[] } | null }} facts the tick's lanes,
 *   side findings and plan (null without --plan)
 * @returns {TestBranch[]} in ref name order
 */
export function testBranches(repo, mainSha, { lanes, tidy, plan }) {
  const refs = gitText(repo.dir, ['for-each-ref', '--format=%(refname)', TEST_BRANCHES]);
  if (refs === '') return [];
  const shownElsewhere = new Set([...lanes.map((lane) => lane.branch), ...tidy.map((finding) => finding.subject)]);
  const folders = new Map(listWorktrees(repo).filter((tree) => tree.branch !== null).map((tree) => [tree.branch, tree.path]));
  return refs.split('\n')
    .map((ref) => ref.slice(HEADS.length))
    .filter((branch) => !shownElsewhere.has(branch))
    .map((branch) => ({
      branch,
      commits: Number(gitText(repo.dir, ['rev-list', '--count', `${mainSha}..${HEADS}${branch}`])),
      folder: folders.get(branch) ?? null,
      piece: plan?.pieces.find((piece) => pieceBranch(piece) === branch)?.id ?? null,
    }))
    .filter((test) => test.commits > 0 || test.folder !== null);
}
