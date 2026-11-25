// Purpose: prove that a branch was folded into another lane: every commit it has that the base lacks is in that lane's own
//   history (its tip or a reflog position, see historyShas and provenHistoryShas), or makes exactly the change a commit of that
//   history made (the same patch id, and the same files before and after). `prune` removes a branch folded into a lane that
//   landed (`folded-branch`, from the landing records of landed-log.mjs) while what that lane landed is still on the base;
//   `check` names a branch folded into a lane that has not landed yet (`in-lane?`), which is never removed.
// Exports: historyShas, provenHistoryShas, commitsOutside, existingCommits, changeIdsOfCommits, isFoldedInto, foldedCandidates,
//   isStillFolded, inLaneHolders, FOLDED_KIND, MAX_REFLOG_ENTRIES.
// Invariants: reads only. A reset ends a history: positions older than the newest `reset:` or `branch: Reset to` entry never
//   count, since the folded work may have been dropped on purpose there. The history land records (provenHistoryShas) also ends
//   at the newest reflog step that may have dropped a commit (`rebase --onto` past it, a `drop`). A patch id alone is no proof:
//   it leaves out line numbers, so the same line added at another place has the same one. Anything git cannot read is no proof
//   (fail closed): a walk that fails, a merge commit outside the history (patch ids skip merges), a commit that changes nothing,
//   a landing whose landed tip is no longer on the base (the landing was undone). Revisions go to git on stdin, one `^<sha>` per
//   line (a command-line `--not` does not apply to revisions read from stdin).
import { createHash } from 'node:crypto';
import { mergeChangesNothing } from './branches.mjs';
import { isAgentBranch, patchIdsOfCommits } from './copies.mjs';
import { gitText, runGit } from './git.mjs';
import { listBranches } from './repo.mjs';

export const FOLDED_KIND = 'folded-branch';
const HEADS = 'refs/heads/';
/** Reflog entries read per branch, as reflog.mjs reads; older positions are left out, which only weakens a proof. */
export const MAX_REFLOG_ENTRIES = 200;
const RESET_SUBJECT = /^(reset: |branch: Reset to )/;
const COMMIT_LINE = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // a full SHA-1 or SHA-256 object name alone on a line

// The reflog entries (newest first) down to and including the newest reset entry.
function sinceReset(entries) {
  const resetAt = entries.findIndex(({ subject }) => RESET_SUBJECT.test(subject));
  return resetAt === -1 ? entries : entries.slice(0, resetAt + 1);
}

/**
 * The positions of a history: `tip`, then the reflog's commits (newest first, as `[{ hash, subject }]`) down to and including
 * the newest reset entry, without repeats.
 */
export function historyShas(tip, entries) {
  return [...new Set([tip, ...sinceReset(entries).map(({ hash }) => hash)])];
}

// Map(commit -> parents) of the existing commits `hashes`, in one git call.
function parentsOf(dir, hashes) {
  if (hashes.length === 0) return new Map();
  const listed = runGit(dir, ['rev-list', '--no-walk=unsorted', '--parents', '--stdin'], `${hashes.join('\n')}\n`);
  if (listed.status !== 0) throw new Error(`git rev-list failed: ${listed.stderr.split('\n')[0]}`);
  return new Map(listed.stdout.split('\n').filter((line) => line !== '').map((line) => line.split(' ')).map(([hash, ...parents]) => [hash, parents]));
}

const sameParents = (a = [], b = []) => a.length === b.length && a.every((parent, i) => parent === b[i]);

// True when the reflog step from `older` to `newer` dropped no commit: newer is older or descends from it (a commit, a
// fast-forward), has older's parents (an amend: it edits only the tip's own change, as a later commit could), or merging older
// into newer changes nothing (a rebase or autosquash that kept every change). Anything else may have dropped one.
function keptEveryChange(dir, { older, newer }, parents) {
  if (older === newer || parents.get(newer)?.includes(older)) return true;
  if (sameParents(parents.get(older), parents.get(newer))) return true;
  if (runGit(dir, ['merge-base', '--is-ancestor', older, newer]).status === 0) return true;
  return mergeChangesNothing({ dir, baseRef: newer }, older);
}

/**
 * The positions of a lane's history that prove what was folded into it, as land records them: `tip`, then its reflog's commits
 * (newest first, `[{ hash, subject }]`) as far back as every step kept every change (a `rebase --onto` that dropped a folded
 * commit ends it), never past the newest reset entry. A reflog that does not start at `tip`, or a commit git no longer has, ends
 * it there. Only existing commits are returned. Throws when git cannot read the commits' parents.
 */
export function provenHistoryShas(dir, tip, entries) {
  const steps = sinceReset(entries);
  if (steps[0]?.hash !== tip) return [tip];
  const present = new Set(existingCommits(dir, [...new Set(steps.map(({ hash }) => hash))]));
  const parents = parentsOf(dir, [...present]);
  const shas = [tip];
  for (let i = 1; i < steps.length; i += 1) {
    const step = { older: steps[i].hash, newer: steps[i - 1].hash };
    if (!present.has(step.older) || !keptEveryChange(dir, step, parents)) break;
    shas.push(step.older);
  }
  return [...new Set(shas)];
}

/**
 * The commits reachable from `include` and from none of `exclude` (revisions or full refs), as `[{ hash, parents, isMerge }]`; null
 * when git cannot walk them (a missing commit).
 */
export function commitsOutside(dir, include, exclude) {
  const input = [...include, ...exclude.map((rev) => `^${rev}`)].join('\n');
  const walk = runGit(dir, ['rev-list', '--parents', '--stdin'], `${input}\n`);
  if (walk.status !== 0) return null;
  return walk.stdout.split('\n').filter((line) => line !== '').map((line) => {
    const [hash, ...parents] = line.split(' ');
    return { hash, parents, isMerge: parents.length > 1 };
  });
}

/** The hashes of `hashes` that name a commit in this repository (`git gc` may have removed an old one), in one git call. */
export function existingCommits(dir, hashes) {
  if (hashes.length === 0) return [];
  const listed = runGit(dir, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${hashes.join('\n')}\n`);
  if (listed.status !== 0) throw new Error(`git cat-file failed: ${listed.stderr.split('\n')[0]}`);
  return listed.stdout.split('\n').filter((line) => line.endsWith(' commit')).map((line) => line.split(' ')[0]);
}

/**
 * Change ids of exactly the commits `hashes`: a SHA-1 of the commit's raw diff against its first parent (each changed file's
 * mode and content before and after, and its path), so two commits share one only when they change the same files from the same
 * content to the same content. One per commit that changes something (an empty or merge commit has none), in one git call.
 * Throws when git cannot read them (a missing commit).
 */
export function changeIdsOfCommits(dir, hashes) {
  if (hashes.length === 0) return [];
  const listed = runGit(dir, ['diff-tree', '--stdin', '--always', '-r', '--root', '--no-renames', '--no-abbrev'], `${hashes.join('\n')}\n`);
  if (listed.status !== 0) throw new Error(`git diff-tree failed: ${listed.stderr.split('\n')[0]}`);
  const changes = [];
  for (const line of listed.stdout.split('\n')) {
    if (COMMIT_LINE.test(line)) changes.push([]);
    else if (line.startsWith(':') && changes.length > 0) changes.at(-1).push(line);
  }
  return changes.filter((lines) => lines.length > 0).map((lines) => createHash('sha1').update(lines.join('\n')).digest('hex'));
}

// True when every commit `hashes` has a patch id in `history.patchIds` and a change id in `history.changeIds`.
function sameChangesIn(dir, hashes, history) {
  const [patches, changes] = [new Set(history.patchIds), new Set(history.changeIds)];
  const ids = patchIdsOfCommits(dir, hashes);
  if (ids.length !== hashes.length || !ids.every((id) => patches.has(id))) return false;
  const changeIds = changeIdsOfCommits(dir, hashes);
  return changeIds.length === hashes.length && changeIds.every((id) => changes.has(id));
}

/**
 * True when every commit of `tip` that the base lacks is reachable from `history.shas`, or (with no merge among the others)
 * each other one makes exactly a change of the history (`history.patchIds` and `history.changeIds`; either null or missing:
 * ancestry only). `history.shas` must exist (existingCommits).
 */
export function isFoldedInto(repo, tip, history) {
  const outside = commitsOutside(repo.dir, [tip], [repo.baseRef, ...history.shas]);
  if (outside === null) return false;
  if (outside.length === 0) return true;
  if (!history.patchIds || !history.changeIds || outside.some(({ isMerge }) => isMerge)) return false;
  return sameChangesIn(repo.dir, outside.map(({ hash }) => hash), history);
}

// The landings whose landed tip is still on the base (a landing the owner undid proves nothing), each with only the positions
// that still exist, so one commit removed by `git gc` does not void a whole record.
function provingLandings(repo, landings) {
  const present = new Set(existingCommits(repo.dir, [...new Set(landings.flatMap(({ shas, landedTip }) => [landedTip, ...shas]))]));
  const tips = [...new Set(landings.map(({ landedTip }) => landedTip).filter((tip) => present.has(tip)))];
  const offBase = tips.length === 0 ? [] : commitsOutside(repo.dir, tips, [repo.baseRef]);
  if (offBase === null) return [];
  const undone = new Set(offBase.map(({ hash }) => hash));
  return landings.filter(({ landedTip }) => present.has(landedTip) && !undone.has(landedTip))
    .map((landing) => ({ ...landing, shas: landing.shas.filter((sha) => present.has(sha)) }));
}

/**
 * The branches folded into a landed lane, as copy candidates `{ name, tip, kind: 'folded-branch', by, landing }` (`by` the
 * landed lane, `landing` its record with the positions that still exist). Only unmerged branches that are not agent branches
 * are looked at (`leftovers.states`), and only landings whose landed tip is still on the base; the newest landing that proves a
 * branch is the one named. `landings` come from readLandings (newest first).
 */
export function foldedCandidates(repo, landings, leftovers) {
  if (landings.length === 0) return [];
  const usable = provingLandings(repo, landings);
  const ids = (field) => usable.flatMap((landing) => landing[field] ?? []);
  const union = { shas: [...new Set(usable.flatMap(({ shas }) => shas))], patchIds: ids('patchIds'), changeIds: ids('changeIds') };
  const lanes = (leftovers.states ?? []).filter(({ state, name }) => state === 'unmerged' && !isAgentBranch(name));
  // One walk against all landings first; only a branch that passes is matched to a single landing.
  return lanes.filter(({ tip }) => isFoldedInto(repo, tip, union)).flatMap(({ name, tip }) => {
    const landing = usable.find((record) => isFoldedInto(repo, tip, record));
    return landing ? [{ kind: FOLDED_KIND, name, tip, by: landing.branch, landing }] : [];
  });
}

/**
 * True when `candidate` (from foldedCandidates) still holds right now: its branch has not moved, what its lane landed is still on
 * the base, and its landing still proves it.
 */
export function isStillFolded(repo, candidate) {
  const current = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${candidate.name}`]);
  if (current.status !== 0 || current.stdout.trim() !== candidate.tip) return false;
  if (runGit(repo.dir, ['merge-base', '--is-ancestor', candidate.landing.landedTip, repo.baseRef]).status !== 0) return false;
  return isFoldedInto(repo, candidate.tip, candidate.landing);
}

const SELECTOR = /^refs\/heads\/(.+)@\{(\d+)\}$/;

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
 * branch is a stacked lane or a folded test branch that goes when that branch lands, so it is a hint only, never removed.
 * Ancestry only (historyShas: a reflog step that dropped a commit is not looked for, since nothing is removed on this hint).
 * `branches` (`[{ name, tip }]`, every local branch but the base, e.g. findLeftovers' states) saves a read. One walk of every
 * history reads the commit graph, so the cost in git calls does not grow with the branches.
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
