// Purpose: prove that a branch was folded into another lane: every commit it has that the base lacks is in that lane's own
//   history (its tip or a reflog position since its newest reset), or has a patch id that history had. `prune` removes a branch
//   folded into a lane that landed (`folded-branch`, from the landing records of landed-log.mjs); `check` names a branch folded
//   into a lane that has not landed yet (`in-lane?`), which is never removed.
// Exports: historyShas, commitsOutside, existingCommits, isFoldedInto, foldedCandidates, isStillFolded, inLaneHolders, FOLDED_KIND,
//   MAX_REFLOG_ENTRIES.
// Invariants: reads only. A reset ends a history: positions older than the newest `reset:` or `branch: Reset to` entry never
//   count, since the folded work may have been dropped on purpose there. Anything git cannot read is no proof (fail closed): a
//   walk that fails, a merge commit outside the history (patch ids skip merges), a commit with no patch id (an empty one).
//   Revisions go to git on stdin, one `^<sha>` per line (a command-line `--not` does not apply to revisions read from stdin).
import { isAgentBranch, patchIdsOfCommits } from './copies.mjs';
import { gitText, runGit } from './git.mjs';
import { listBranches } from './repo.mjs';

export const FOLDED_KIND = 'folded-branch';
const HEADS = 'refs/heads/';
/** Reflog entries read per branch, as reflog.mjs reads; older positions are left out, which only weakens a proof. */
export const MAX_REFLOG_ENTRIES = 200;
const RESET_SUBJECT = /^(reset: |branch: Reset to )/;

/**
 * The positions of a history: `tip`, then the reflog's commits (newest first, as `[{ hash, subject }]`) down to and including
 * the newest reset entry, without repeats.
 */
export function historyShas(tip, entries) {
  const resetAt = entries.findIndex(({ subject }) => RESET_SUBJECT.test(subject));
  const kept = resetAt === -1 ? entries : entries.slice(0, resetAt + 1);
  return [...new Set([tip, ...kept.map(({ hash }) => hash)])];
}

/**
 * The commits reachable from `include` and from none of `exclude` (revisions or full refs), as `[{ hash, isMerge }]`; null
 * when git cannot walk them (a missing commit).
 */
export function commitsOutside(dir, include, exclude) {
  const input = [...include, ...exclude.map((rev) => `^${rev}`)].join('\n');
  const walk = runGit(dir, ['rev-list', '--parents', '--stdin'], `${input}\n`);
  if (walk.status !== 0) return null;
  return walk.stdout.split('\n').filter((line) => line !== '').map((line) => {
    const [hash, ...parents] = line.split(' ');
    return { hash, isMerge: parents.length > 1 };
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
 * True when every commit of `tip` that the base lacks is reachable from `history.shas`, or (with no merge among the others)
 * each other one has a patch id in `history.patchIds` (null: ancestry only). `history.shas` must exist (existingCommits).
 */
export function isFoldedInto(repo, tip, history) {
  const outside = commitsOutside(repo.dir, [tip], [repo.baseRef, ...history.shas]);
  if (outside === null) return false;
  if (outside.length === 0) return true;
  if (history.patchIds === null || outside.some(({ isMerge }) => isMerge)) return false;
  const known = new Set(history.patchIds);
  const ids = patchIdsOfCommits(repo.dir, outside.map(({ hash }) => hash));
  return ids.length === outside.length && ids.every((id) => known.has(id));
}

// The landings with only the positions that still exist, so one commit removed by `git gc` does not void a whole record.
function withExistingShas(repo, landings) {
  const present = new Set(existingCommits(repo.dir, [...new Set(landings.flatMap(({ shas }) => shas))]));
  return landings.map((landing) => ({ ...landing, shas: landing.shas.filter((sha) => present.has(sha)) }));
}

/**
 * The branches folded into a landed lane, as copy candidates `{ name, tip, kind: 'folded-branch', by, landing }` (`by` the
 * landed lane, `landing` its record with the positions that still exist). Only unmerged branches that are not agent branches
 * are looked at (`leftovers.states`); the newest landing that proves a branch is the one named. `landings` come from
 * readLandings (newest first).
 */
export function foldedCandidates(repo, landings, leftovers) {
  if (landings.length === 0) return [];
  const usable = withExistingShas(repo, landings);
  const union = { shas: [...new Set(usable.flatMap(({ shas }) => shas))], patchIds: usable.flatMap(({ patchIds }) => patchIds ?? []) };
  const lanes = (leftovers.states ?? []).filter(({ state, name }) => state === 'unmerged' && !isAgentBranch(name));
  // One walk against all landings first; only a branch that passes is matched to a single landing.
  return lanes.filter(({ tip }) => isFoldedInto(repo, tip, union)).flatMap(({ name, tip }) => {
    const landing = usable.find((record) => isFoldedInto(repo, tip, record));
    return landing ? [{ kind: FOLDED_KIND, name, tip, by: landing.branch, landing }] : [];
  });
}

/** True when `candidate` (from foldedCandidates) still holds right now: its branch has not moved and its landing still proves it. */
export function isStillFolded(repo, candidate) {
  const current = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${candidate.name}`]);
  return current.status === 0 && current.stdout.trim() === candidate.tip && isFoldedInto(repo, candidate.tip, candidate.landing);
}

const SELECTOR = /^refs\/heads\/(.+)@\{(\d+)\}$/;

// Every local branch's history (historyShas) from one reflog read, as Map(name -> shas). `reflog show --all` mixes the refs by
// date, so each entry is put at its own `@{n}` place.
function branchHistories(repo) {
  const entries = new Map();
  for (const line of gitText(repo.dir, ['reflog', 'show', '--all', '--format=%gD%x00%H%x00%gs']).split('\n')) {
    const [selector, hash, subject] = line.split('\0');
    const [, name, place] = SELECTOR.exec(selector ?? '') ?? [];
    if (name === undefined || Number(place) >= MAX_REFLOG_ENTRIES) continue;
    if (!entries.has(name)) entries.set(name, []);
    entries.get(name)[Number(place)] = { hash, subject };
  }
  const newestFirst = (name) => (entries.get(name) ?? []).filter((entry) => entry !== undefined);
  return new Map(listBranches(repo).map(({ name, tip }) => [name, historyShas(tip, newestFirst(name))]));
}

/**
 * For the unmerged branches `names`: Map(name -> the live branch whose history holds all its commits). Such a branch is a
 * stacked lane or a folded test branch that goes when that branch lands, so it is a hint only, never removed. Ancestry only.
 */
export function inLaneHolders(repo, names) {
  if (names.length === 0) return new Map();
  const histories = branchHistories(repo);
  const holders = new Map();
  for (const name of names) {
    const tip = histories.get(name)?.[0];
    const others = [...histories].filter(([other]) => other !== name && other !== repo.base);
    const inAll = tip !== undefined && commitsOutside(repo.dir, [tip], [repo.baseRef, ...new Set(others.flatMap(([, shas]) => shas))])?.length === 0;
    const holder = inAll ? others.find(([, shas]) => commitsOutside(repo.dir, [tip], [repo.baseRef, ...shas])?.length === 0) : undefined;
    if (holder) holders.set(name, holder[0]);
  }
  return holders;
}
