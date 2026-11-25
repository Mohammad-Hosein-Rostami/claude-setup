// Purpose: the `in-lane?` hint of `check` and the `in <B> (lands with it)` line of land's `left:` list: an unmerged branch whose
//   every commit is in the history (tip, or reflog since its newest reset) of another live branch, a stacked lane or a test
//   branch folded into a lane. Only a hint: nothing is ever deleted on it (branches.mjs holds the one proof that deletes).
// Exports: inLaneHolders.
// Invariants: reads only. A reset ends a history: positions older than the newest `reset:` or `branch: Reset to` entry never
//   count. A reflog step that dropped a commit (`rebase --onto`) is not looked for, so the hint can name a holder that no
//   longer holds a commit; the branch then stays when that holder lands. A walk git cannot do gives no hint (fail closed).
//   Revisions go to git on stdin, one `^<sha>` per line (a command-line `--not` does not apply to revisions read from stdin).
import { gitText, runGit } from './git.mjs';
import { listBranches } from './repo.mjs';

// Reflog entries read per branch, as reflog.mjs reads; older positions are left out, which only weakens the hint.
const MAX_REFLOG_ENTRIES = 200;
const RESET_SUBJECT = /^(reset: |branch: Reset to )/;
const SELECTOR = /^refs\/heads\/(.+)@\{(\d+)\}$/;

// `tip`, then the reflog's commits (newest first, `[{ hash, subject }]`) down to and including the newest reset, without repeats.
function historyShas(tip, entries) {
  const resetAt = entries.findIndex(({ subject }) => RESET_SUBJECT.test(subject));
  const kept = resetAt === -1 ? entries : entries.slice(0, resetAt + 1);
  return [...new Set([tip, ...kept.map(({ hash }) => hash)])];
}

// The commits reachable from `include` and from none of `exclude`, as `[{ hash, parents }]`; null when git cannot walk them.
function commitsOutside(dir, include, exclude) {
  const input = [...include, ...exclude.map((rev) => `^${rev}`)].join('\n');
  const walk = runGit(dir, ['rev-list', '--parents', '--stdin'], `${input}\n`);
  if (walk.status !== 0) return null;
  return walk.stdout.split('\n').filter((line) => line !== '').map((line) => {
    const [hash, ...parents] = line.split(' ');
    return { hash, parents };
  });
}

// The hashes of `hashes` that name a commit in this repository (`git gc` may have removed an old one), in one git call.
function existingCommits(dir, hashes) {
  if (hashes.length === 0) return [];
  const listed = runGit(dir, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${hashes.join('\n')}\n`);
  if (listed.status !== 0) throw new Error(`git cat-file failed: ${listed.stderr.split('\n')[0]}`);
  return listed.stdout.split('\n').filter((line) => line.endsWith(' commit')).map((line) => line.split(' ')[0]);
}

// Every branch of `branches` (`[{ name, tip }]`) with its history (historyShas) from one reflog read, as Map(name -> shas).
// `reflog show --all` mixes the refs by date, so each entry is put at its own `@{n}` place.
function branchHistories(repo, branches) {
  const entries = new Map();
  for (const line of gitText(repo.dir, ['reflog', 'show', '--all', '--format=%gD%x00%H%x00%gs']).split('\n')) {
    const [selector, hash, subject] = line.split('\0');
    const [, name, place] = SELECTOR.exec(selector ?? '') ?? [];
    if (name === undefined || Number(place) >= MAX_REFLOG_ENTRIES) continue;
    if (!entries.has(name)) entries.set(name, []);
    entries.get(name)[Number(place)] = { hash, subject };
  }
  const newestFirst = (name) => (entries.get(name) ?? []).filter((entry) => entry !== undefined);
  return new Map(branches.filter(({ tip }) => tip).map(({ name, tip }) => [name, historyShas(tip, newestFirst(name))]));
}

// The commits of `graph` (Map(hash -> parents), commits the base lacks) reachable from `starts`.
function reachableIn(graph, starts) {
  const seen = new Set();
  const pending = starts.filter((hash) => graph.has(hash));
  while (pending.length > 0) {
    const hash = pending.pop();
    if (seen.has(hash)) continue;
    seen.add(hash);
    pending.push(...graph.get(hash).filter((parent) => graph.has(parent)));
  }
  return seen;
}

/**
 * For the unmerged branches `names`: Map(name -> the live branch whose history holds all its commits, so its tip). Such a
 * branch is a stacked lane or a folded test branch, so it is a hint only, never removed. `branches` (`[{ name, tip }]`, every
 * local branch but the base, e.g. findLeftovers' states) saves a read. One walk of every history reads the commit graph, so
 * the cost in git calls does not grow with the branches.
 */
export function inLaneHolders(repo, names, branches = listBranches(repo)) {
  if (names.length === 0) return new Map();
  const histories = branchHistories(repo, branches);
  const present = new Set(existingCommits(repo.dir, [...new Set([...histories.values()].flat())]));
  const graph = new Map((commitsOutside(repo.dir, [...present], [repo.baseRef]) ?? []).map(({ hash, parents }) => [hash, parents]));
  const holders = new Map();
  for (const [holder, shas] of histories) {
    if (holder === repo.base || holders.size === names.length) continue;
    const reach = reachableIn(graph, shas.filter((sha) => present.has(sha)));
    for (const name of names) {
      const tip = histories.get(name)?.[0];
      // Two branches at one tip are copies of each other (copies.mjs decides which stays), so neither holds the other.
      if (!holders.has(name) && tip !== shas[0] && reach.has(tip)) holders.set(name, holder);
    }
  }
  return holders;
}
