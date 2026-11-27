// Purpose: the queue side of `board tick` (plan-core-best cb-hold-1): which waiting pieces of every job the tick reads can start
//   now and what holds each other one back, the overlaps among lanes and pieces, the strays among the lanes' files, and the
//   `queue` line.
// Exports: queuesOf({ works, lanes, entries, holds, clashed }) -> { queues, overlaps }, straysOf(lanes, pieces), queueLine(queue).
// Invariants: a piece is startable only when its `after` pieces have landed, each branch of its `waits` has a land in the ledger,
//   no plan names its branch twice (clash), no lane shares a file with it, no hold (tick-features.mjs) is on one of its files, and
//   no startable piece before it (plan order, then piece order, across every job) shares a file with it: so the pieces `next:`
//   claims never meet each other. Pure: the lanes, ledger entries and holds come from tick.mjs.
import { cleanText } from './cells.mjs';
import { heldBy, pieceBranch } from './tick-features.mjs';

// cleanText reads only `ascii` from a look: these lines keep non-ASCII names as they are and carry no colour
const PLAIN_LOOK = { ascii: false };

const clean = (text) => cleanText(text, PLAIN_LOOK);
const sharedFiles = (first, second) => first.filter((path) => second.includes(path));

/**
 * `overlap` pairs: two lanes sharing a file, or a waiting piece (after-steps and waits landed) whose declared files touch a lane
 * (isPiece, with the piece's `job`: two plans may reuse a piece id).
 */
function overlapsOf(lanes, candidates) {
  const pairs = lanes.flatMap((lane, at) => lanes.slice(at + 1).map((other) => ({ first: lane.branch, second: other.branch, files: sharedFiles(lane.files, other.files), isPiece: false })));
  const touches = candidates.flatMap((piece) => lanes.map((lane) => ({ first: piece.id, job: piece.job, second: lane.branch, files: sharedFiles(piece.files, lane.files), isPiece: true })));
  return [...pairs, ...touches].filter((pair) => pair.files.length > 0);
}

/**
 * One waiting piece in its job's queue: the branch it names (null for `lane/<id>`), its files, the pieces it is after, the
 * branches it waits on that have not landed, the lanes its files touch, the holds on its files, whether another plan names its
 * branch too (isClash), and whether it can start now.
 */
function queueEntry(piece, { overlaps, holds, clashed }) {
  const touched = overlaps.filter((pair) => pair.isPiece && pair.job === piece.job && pair.first === piece.id).map((pair) => pair.second);
  const held = heldBy(holds, piece.files);
  const isClash = clashed.has(pieceBranch(piece));
  const isStartable = piece.after.length === 0 && piece.waits.length === 0 && touched.length === 0 && held.length === 0 && !isClash;
  return { id: piece.id, branch: piece.branch, files: piece.files, after: piece.after, waits: piece.waits, overlaps: touched, held, isClash, isStartable };
}

/**
 * Keeps the startable pieces file-disjoint: in queue order, a startable piece that shares a file with one kept before it waits for
 * that one (`overlaps <piece>`). Every two startable pieces that share a file are an `overlap` pair (isPiece; plan-core-best C1).
 */
function keepDisjoint(queues) {
  const startable = []; // { piece, isKept } in queue order
  const pairs = [];
  const kept = queues.map((queue) => queue.map((piece) => {
    if (!piece.isStartable) return piece;
    const met = startable.map((earlier) => ({ ...earlier, files: sharedFiles(earlier.piece.files, piece.files) })).filter(({ files }) => files.length > 0);
    pairs.push(...met.map(({ piece: earlier, files }) => ({ first: earlier.id, second: piece.id, files, isPiece: true })));
    const blockers = met.filter(({ isKept }) => isKept).map(({ piece: earlier }) => earlier.id);
    startable.push({ piece, isKept: blockers.length === 0 });
    return blockers.length === 0 ? piece : { ...piece, overlaps: blockers, isStartable: false };
  }));
  return { queues: kept, pairs };
}

/**
 * Every job's queue and the overlaps of the tick.
 * @param {object} facts the tick's facts
 * @param {{ plan: object, work: { waiting: object[] } }[]} facts.works each plan with its planState, in the list's order
 * @param {{ branch: string, files: string[] }[]} facts.lanes the lanes in flight, with the declared files of their pieces
 * @param {{ branch: string }[]} facts.entries the whole land ledger: a `waits` branch counts once it has a land there
 * @param {{ feature: string, files: string[] }[]} facts.holds the holds of every plan
 * @param {Set<string>} facts.clashed the branches two plans both name
 * @returns {{ queues: object[][], overlaps: object[] }} one queue per work (queueEntry's fields), and the lane pairs, the pieces
 *   that touch a lane and the startable pieces that share a file
 */
export function queuesOf({ works, lanes, entries, holds, clashed }) {
  const landedBranches = new Set(entries.map(({ branch }) => branch));
  const waiting = works.map(({ plan, work }) => work.waiting.map((piece) => ({ ...piece, job: plan.job, waits: (piece.waits ?? []).filter((branch) => !landedBranches.has(branch)) })));
  const candidates = waiting.flat().filter((piece) => piece.after.length === 0 && piece.waits.length === 0);
  const laneOverlaps = overlapsOf(lanes, candidates);
  const { queues, pairs } = keepDisjoint(waiting.map((pieces) => pieces.map((piece) => queueEntry(piece, { overlaps: laneOverlaps, holds, clashed }))));
  return { queues, overlaps: [...laneOverlaps, ...pairs] };
}

/** `stray` lanes: a lane of a plan piece (of any job) that changed files the piece does not declare. */
export function straysOf(lanes, pieces) {
  return lanes.flatMap((lane) => {
    const piece = pieces.find((entry) => pieceBranch(entry) === lane.branch);
    const files = piece === undefined ? [] : lane.files.filter((path) => !piece.files.includes(path));
    return files.length === 0 ? [] : [{ branch: lane.branch, files }];
  });
}

/** Why a waiting piece can or cannot start: `startable`, else every blocker it has, joined by `; `. */
function pieceState(piece) {
  if (piece.isStartable) return 'startable';
  return [
    piece.isClash ? 'clash' : '',
    piece.after.length > 0 ? `after ${piece.after.join(', ')}` : '',
    piece.waits.length > 0 ? `waits ${piece.waits.map(clean).join(', ')}` : '',
    piece.overlaps.length > 0 ? `overlaps ${piece.overlaps.map(clean).join(', ')}` : '',
    piece.held.length > 0 ? `held by ${piece.held.join(', ')}` : '',
  ].filter((text) => text !== '').join('; ');
}

/** The `queue` line of one job: each waiting piece and its state, or `queue empty`. */
export function queueLine(queue) {
  return queue.length === 0 ? 'queue empty' : `queue ${queue.map((piece) => `${piece.id} ${pieceState(piece)}`).join(' | ')}`;
}
