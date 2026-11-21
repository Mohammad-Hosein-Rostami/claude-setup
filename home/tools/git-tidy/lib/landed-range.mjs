// Purpose: `git-tidy range`: find the fast-forward of the base that landed a lane, from the base's reflog, so a restarted `land` can write
//   `landed <to> on <base> from <from>` for a landing a killed run already made (spec-p3 `r9-land-speed`, spec-stages section 10 item 19).
// Exports: landedRange(repo, reviewedTip, { landed }) -> { from, to } | null.
// Invariants: reads only. The newest MAX_ENTRIES reflog entries of the base are read; an entry `to` with the one before it `from` holds the
//   lane when every patch of the reviewed tip that is not on the base is in `from..to` (patch-id, counted with repeats), or, for a
//   reviewed tip that is itself on the base, when the tip is in `from..to`. `landed`, when given, must also be in that range. No match
//   (the reflog expired or never held it): null, and the caller writes no `from`.
import { patchIdsOf } from './copies.mjs';
import { gitFlag, gitText, runGit } from './git.mjs';

const MAX_ENTRIES = 200;
const PLAIN_DIFF = ['--no-ext-diff', '--no-textconv', '--no-show-signature', '--no-color'];

/** Patch ids of the commits in `from..to`. */
function rangePatchIds(repo, from, to) {
  const log = runGit(repo.dir, ['log', '-p', '--no-merges', ...PLAIN_DIFF, `${from}..${to}`, '--']);
  if (log.status !== 0) throw new Error(`git log failed for ${from}..${to}: ${log.stderr.split('\n')[0]}`);
  const ids = runGit(repo.dir, ['patch-id', '--verbatim'], log.stdout);
  if (ids.status !== 0) throw new Error(`git patch-id failed: ${ids.stderr.split('\n')[0]}`);
  return ids.stdout.split('\n').filter((line) => line !== '').map((line) => line.split(' ')[0]);
}

/** True when every id of `wanted` is in `have` (each counted as often as it occurs). */
function holdsAll(have, wanted) {
  const left = new Map();
  for (const id of have) left.set(id, (left.get(id) ?? 0) + 1);
  return wanted.every((id) => (left.get(id) > 0 ? (left.set(id, left.get(id) - 1), true) : false));
}

const inRange = (repo, sha, from, to) => gitFlag(repo.dir, ['merge-base', '--is-ancestor', sha, to]) && !gitFlag(repo.dir, ['merge-base', '--is-ancestor', sha, from]);

/** The base's reflog values, newest first, at most MAX_ENTRIES + 1 (so MAX_ENTRIES pairs). */
const reflogTips = (repo) => gitText(repo.dir, ['reflog', 'show', '-n', String(MAX_ENTRIES + 1), '--format=%H', repo.baseRef, '--'])
  .split('\n').filter((line) => line !== '');

/**
 * The reflog step of the base that landed the lane.
 * @param {object} repo the repository (openRepo)
 * @param {string} reviewedTip the sha the review cleared (before the rebase)
 * @param {{ landed?: string|null }} [options] a commit that must lie in the found range (the lane branch's tip after a restart)
 * @returns {{ from: string, to: string } | null}
 */
export function landedRange(repo, reviewedTip, { landed = null } = {}) {
  const tip = gitText(repo.dir, ['rev-parse', '--verify', '--end-of-options', `${reviewedTip}^{commit}`]);
  const lanePatches = patchIdsOf(repo, tip);
  const tips = reflogTips(repo);
  for (let i = 0; i + 1 < tips.length; i++) {
    const [to, from] = [tips[i], tips[i + 1]];
    if (from === to || !gitFlag(repo.dir, ['merge-base', '--is-ancestor', from, to])) continue;
    if (landed !== null && !inRange(repo, landed, from, to)) continue;
    const holds = lanePatches.length === 0 ? inRange(repo, tip, from, to) : holdsAll(rangePatchIds(repo, from, to), lanePatches);
    if (holds) return { from, to };
  }
  return null;
}
