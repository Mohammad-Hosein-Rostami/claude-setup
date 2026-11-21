// Purpose: the base's upstream before `git-tidy land` fast-forwards it (spec-p3 `r9-git-line`, O3): fetch the upstream with a timeout (a fetch,
//   never a push), then compare. Commits on the upstream that the base lacks (a push from elsewhere) stop the landing ("upstream moved");
//   otherwise the landing goes on and reports how many base commits are already published, since those are never amended, rebased or pruned
//   without the owner's yes (C37).
// Exports: upstreamState.
// Invariants: reads and fetches only (the fetch updates only the remote-tracking ref); an offline or timed-out fetch is a WARN line and the
//   compare uses the last fetched ref; a base with no upstream reports nothing and never stops a landing.
import { gitText, runGit } from './git.mjs';

const FETCH_TIMEOUT_MS = 20_000; // one fetch of one branch; a slower or unreachable remote warns instead of holding the landing

/** `git config --get <key>` in `dir`, or '' when unset. */
const configOf = (dir, key) => {
  const read = runGit(dir, ['config', '--get', key]);
  return read.status === 0 ? read.stdout.trim() : '';
};

/** Fetches the base's upstream branch; returns null on success, else the WARN reason (offline, timed out, refused). */
function fetchUpstream(repo) {
  const remote = configOf(repo.dir, `branch.${repo.base}.remote`);
  const merge = configOf(repo.dir, `branch.${repo.base}.merge`);
  if (remote === '' || remote === '.' || merge === '') return null; // a local upstream needs no fetch
  try {
    const fetched = runGit(repo.dir, ['fetch', '--quiet', '--no-tags', remote, merge], undefined, { timeoutMs: FETCH_TIMEOUT_MS });
    return fetched.status === 0 ? null : `fetch of ${repo.upstream.name} failed (${fetched.stderr.split('\n')[0] || `exit ${fetched.status}`})`;
  } catch (error) {
    return `fetch of ${repo.upstream.name} did not finish in ${FETCH_TIMEOUT_MS / 1000} s (${error.message})`;
  }
}

/**
 * The upstream compare of `repo`'s base (from openRepo).
 * @param {object} repo the repository (openRepo), whose `upstream` is `{ ref, name }` or null
 * @returns {{ upstream: string|null, moved: number, published: number, unpublished: number, warn: string|null }} `moved`: upstream commits
 *   the base lacks (above 0 stops the landing); `published`: base commits already on the upstream; `unpublished`: base commits not pushed;
 *   `warn`: why the fetch did not happen (the counts then use the last fetched ref)
 */
export function upstreamState(repo) {
  if (repo.upstream === null) return { upstream: null, moved: 0, published: 0, unpublished: 0, warn: null };
  const warn = fetchUpstream(repo);
  const count = (range) => Number(gitText(repo.dir, ['rev-list', '--count', range]));
  const known = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', repo.upstream.ref]).status === 0;
  if (!known) return { upstream: repo.upstream.name, moved: 0, published: 0, unpublished: 0, warn: warn ?? `${repo.upstream.name} was never fetched` };
  const unpublished = count(`${repo.upstream.ref}..${repo.baseRef}`);
  return { upstream: repo.upstream.name, moved: count(`${repo.baseRef}..${repo.upstream.ref}`), published: count(repo.baseRef) - unpublished, unpublished, warn };
}
