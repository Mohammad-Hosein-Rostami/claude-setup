// Purpose: the lane side of `board tick` (moved out of tick.mjs, which stays under its size cap): the pool's folders with their
//   locks, each lane in flight with its commits and files against the base, the declared files of its plan piece and the holds on
//   them, the board agent on a branch, and the live tess agents with the pool folders their names name.
// Exports: agentOn(agents, branch), laneOf(repo, mainSha, slot, agents), withDeclaredFiles(lane, pieces), heldLane(lane, holds),
//   foldersOf(repo), liveTessOf(agents).
// Invariants: reads git and the board's agents only, writes nothing; plumbing (diff-tree, status -z) only, so no textconv or
//   external diff program the repository names runs, and a path's spaces are kept.
import { readLaneBase } from '../../git-tidy/lib/base-record.mjs';
import { gitText, runGit } from '../../git-tidy/lib/git.mjs';
import { poolSlots } from '../../git-tidy/lib/lane-pool.mjs';
import { slotKey } from '../../git-tidy/lib/lane-slots.mjs';
import { listWorktrees } from '../../git-tidy/lib/repo.mjs';
import { heldBy, pieceBranch } from './tick-features.mjs';
import { clean } from './tick-lines.mjs';

const MISSING_FOLDER = 'missing'; // lane-slots.mjs: the folder is gone, so git cannot run in it
const STATUS_CODE_CHARS = 3; // `XY ` before each path in `git status --porcelain -z`
const RENAMED = /^(?:[RC]|.[RC])/; // a rename or copy (staged or in the folder): -z puts its old path in the next field
const LANE_NAME = /\blane-(\d+)\b/gi; // a pool folder in an agent's name, as a whole word (`tess lane-5 <feature>`: start.mjs)

const nulList = (text) => text.split('\0').filter((path) => path !== '');

/** The changed and untracked paths in a lane's folder (renames give both paths), or null when git cannot say. */
function changedPaths(folder) {
  const { status, stdout } = runGit(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  if (status !== 0) return null;
  const fields = nulList(stdout);
  const paths = [];
  for (let at = 0; at < fields.length; at++) {
    paths.push(fields[at].slice(STATUS_CODE_CHARS));
    if (RENAMED.test(fields[at])) paths.push(fields[++at]);
  }
  return paths;
}

/** The board agent on `branch`: a live one first, else the first done one in the board's order; null when none is there. */
export function agentOn(agents, branch) {
  const own = agents.filter((agent) => agent.branch === branch);
  const agent = own.find((entry) => entry.state !== 'done') ?? own[0];
  return agent === undefined ? null : { id: agent.id, type: agent.type, state: agent.state, quietMin: agent.quietMin };
}

/**
 * One lane in flight: a pool folder holding a branch, with its commits and files against the base, the base it was claimed on
 * (`claimedOn`, null for a lane with no record) and its agent.
 */
export function laneOf(repo, mainSha, slot, agents) {
  const ref = `refs/heads/${slot.branch}`;
  const forkPoint = gitText(repo.dir, ['merge-base', mainSha, ref]);
  // plumbing (diff-tree), not `diff`: plumbing never runs a textconv or external diff program the repository names
  const committed = runGit(repo.dir, ['diff-tree', '-r', '--name-only', '-z', forkPoint, ref]); // runGit: gitText's trim would cut a path's spaces
  if (committed.status !== 0) throw new Error(`git diff-tree failed for ${clean(slot.branch)}: ${committed.stderr}`);
  const changed = slot.state === MISSING_FOLDER ? null : changedPaths(slot.folder);
  const agent = agentOn(agents, slot.branch);
  const commits = Number(gitText(repo.dir, ['rev-list', '--count', `${mainSha}..${ref}`]));
  const claimedOn = readLaneBase(repo.dir, slot.branch);
  const isOnBase = claimedOn === null || claimedOn === repo.base; // land refuses a lane claimed on another base
  return {
    branch: slot.branch, slot: slot.slot, folder: slot.folder, folderState: slot.state, agent, commits, changed, claimedOn,
    files: [...new Set([...nulList(committed.stdout), ...(changed ?? [])])],
    mainMoved: forkPoint !== mainSha,
    isReady: (agent === null || agent.state === 'done') && commits > 0 && changed?.length === 0 && isOnBase,
  };
}

/**
 * The lane with the declared files of the plan piece on its branch added (cb-hold-1 d): a lane with no commit yet already holds
 * the files its piece will change, for the overlaps and the holds.
 */
export function withDeclaredFiles(lane, pieces) {
  const piece = pieces.find((entry) => pieceBranch(entry) === lane.branch);
  return piece === undefined ? lane : { ...lane, files: [...new Set([...lane.files, ...piece.files])] };
}

/** The lane with the holds on its files (`held`): a held lane is never ready, so `next:` never lands it before tess returns. */
export function heldLane(lane, holds) {
  const held = heldBy(holds, lane.files);
  return { ...lane, held, isReady: lane.isReady && held.length === 0 };
}

/**
 * The pool's folders, each with its lock: the time it was taken (`lockedAtMs`, null when unlocked or unknown) for the snapshot
 * age, and its reason (`lockReason`, null when unlocked), which a release line passes as `--expect`.
 */
export function foldersOf(repo) {
  const trees = new Map(listWorktrees(repo).map((tree) => [slotKey(tree.path), tree]));
  return poolSlots(repo).map((slot) => {
    const tree = trees.get(slotKey(slot.folder));
    return { ...slot, lockedAtMs: tree?.lockedAtMs ?? null, lockReason: tree?.lockReason ?? null };
  });
}

/** The live tess agents of the board, each with the pool folders its name names: a snapshot one of them names stays claimed. */
export const liveTessOf = (agents) => agents.filter((agent) => agent.type === 'tess' && agent.state !== 'done')
  .map((agent) => ({ id: agent.id, name: agent.name, slots: [...agent.name.matchAll(LANE_NAME)].map((match) => `lane-${Number(match[1])}`) }));
