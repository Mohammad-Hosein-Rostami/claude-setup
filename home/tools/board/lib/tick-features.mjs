// Purpose: the plan's side of `board tick`: which pieces wait, how far each feature has landed, which features tess has checked,
//   whether a tess round is due, and the lines that say so.
// Exports: pieceBranch(piece), planState(repo, plan, lanes, entries, marks), featuresLine(planState), commitsLines(planState).
// Invariants: a feature is checked only when it has a tess mark, every ledger `to` of its pieces' branches is an ancestor of the
//   mark's sha (gate R1: a mark's time says nothing about which lands tess saw) and tess recorded `done` with verdict `ok` on that
//   mark (`board done`; plan-core-best cb-done-1): a mark alone, from a tess still running or one that died, checks nothing. A
//   `must-fix` on such a mark is not due again until a piece of the feature lands after it (the fix). A git call that fails counts
//   as not covered, so a doubt always reads `tess due`. Reads git and nothing else; the plan, ledger entries and marks come
//   checked (tick-plan.mjs, land/ledger.mjs).
import { runGit } from '../../git-tidy/lib/git.mjs';
import { cleanText } from './cells.mjs';

const LANE_PREFIX = 'lane/';
const TESS_DUE_AT = 3; // fully landed features not yet checked that make a tess round due
const NO_RISK = 'none';
const VERDICT_OK = 'ok'; // the one verdict of tick-plan.mjs VERDICTS that checks a feature
const SHORT_SHA = 8;
// cleanText reads only `ascii` from a look: these lines keep non-ASCII names as they are and carry no colour
const PLAIN_LOOK = { ascii: false };

const clean = (text) => cleanText(text, PLAIN_LOOK);
const short = (sha) => sha.slice(0, SHORT_SHA);

/** The branch a plan piece is built on: its own `branch` (a `Fix:` on tess-write's `test/<topic>`), else `lane/<piece id>`. */
export const pieceBranch = (piece) => piece.branch ?? `${LANE_PREFIX}${piece.id}`;

/** Whether commit `to` is in the history of `sha`; any failure (an unknown commit, a git error) counts as not covered. */
const isCovered = (repo, to, sha) => runGit(repo.dir, ['merge-base', '--is-ancestor', to, sha]).status === 0;

/**
 * One feature's progress: pieces landed, every land of its pieces in ledger order, tess's verdict on a mark whose sha holds all of
 * them (null when there is no such mark or tess has not returned on it), and whether that verdict checks the feature.
 */
function featureState(repo, feature, pieces, planLands, mark) {
  const own = new Set(pieces.filter((piece) => piece.feature === feature.id).map((piece) => piece.id));
  // filtered from the ledger-ordered list, never gathered piece by piece: the first range must start at the oldest land (gate R4)
  const lands = planLands.filter(({ piece }) => own.has(piece));
  const landed = new Set(lands.map(({ piece }) => piece)).size;
  const isCoveredAll = mark !== undefined && lands.every(({ to }) => isCovered(repo, to, mark.sha));
  // a verdict counts only on a mark that holds every land: a land after the mark is one tess has not seen
  const verdict = isCoveredAll ? (mark.done?.verdict ?? null) : null;
  return { id: feature.id, risk: feature.risk, landed, pieces: own.size, lands, verdict, isChecked: verdict === VERDICT_OK };
}

/**
 * Whether a tess round is due (design section 1, step 5, and the owner's rule for risky features): a risky feature landed and
 * not checked, TESS_DUE_AT features fully landed and not checked, or the job's last piece landed. A landed feature with a
 * `must-fix` verdict waits for its fix (`fixing`): not checked, but never due until a piece of it lands again.
 */
function tessDue(features, isJobLanded) {
  const unchecked = features.filter((feature) => feature.landed > 0 && feature.verdict === null);
  const fixing = features.filter((feature) => feature.landed > 0 && feature.verdict !== null && !feature.isChecked);
  const risky = unchecked.filter((feature) => feature.risk !== NO_RISK);
  const full = unchecked.filter((feature) => feature.landed === feature.pieces);
  let reason = null;
  if (risky.length > 0) reason = `risky ${risky.map((feature) => feature.id).join(', ')}`;
  else if (full.length >= TESS_DUE_AT) reason = `${full.length} features landed`;
  else if (isJobLanded && unchecked.length > 0) reason = 'last piece landed';
  const listed = unchecked.filter((feature) => feature.risk !== NO_RISK || feature.landed === feature.pieces);
  return { reason, fullyLanded: full.length, features: listed, fixing };
}

/**
 * The plan's side of the tick.
 * @param {{ dir: string }} repo openRepo's result (git runs there)
 * @param {object} plan readPlan's result
 * @param {{ branch: string }[]} lanes the lanes in flight
 * @param {{ branch: string, from: string, to: string }[]} entries the land ledger, oldest first
 * @param {Record<string, { sha: string, at: string, done?: { verdict: string } }>} marks the job's tess marks (readMarks)
 * @returns {{ waiting: object[], features: object[], tess: object, lastTessSha: string | null, landedSince: number }} the waiting
 *   pieces (their `after` cut to the unlanded ones), each feature with `lands: [{ piece, from, to }]` in ledger order and its
 *   `verdict`, the tess status (`features` listed for tess, `fixing` waiting for a fix), the newest mark's sha and the pieces
 *   with a land that sha does not hold
 */
export function planState(repo, plan, lanes, entries, marks) {
  const pieceOfBranch = new Map(plan.pieces.map((piece) => [pieceBranch(piece), piece.id]));
  // every land of a plan piece, oldest first as the ledger holds them
  const planLands = entries.filter(({ branch }) => pieceOfBranch.has(branch))
    .map(({ branch, from, to }) => ({ piece: pieceOfBranch.get(branch), from, to }));
  const landedIds = new Set(planLands.map(({ piece }) => piece));
  const isLanded = (id) => landedIds.has(id);
  const inFlight = new Set(lanes.map((lane) => lane.branch));
  const waiting = plan.pieces.filter((piece) => !isLanded(piece.id) && !inFlight.has(pieceBranch(piece)))
    .map((piece) => ({ ...piece, after: piece.after.filter((id) => !isLanded(id)) }));
  // own keys only: a feature named `constructor` must not read Object.prototype's as its mark
  const markOf = (id) => (Object.hasOwn(marks, id) ? marks[id] : undefined);
  const features = plan.features.map((feature) => featureState(repo, feature, plan.pieces, planLands, markOf(feature.id)));
  const lastMark = Object.values(marks).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  const uncovered = planLands.filter(({ to }) => lastMark === null || !isCovered(repo, to, lastMark.sha));
  const landedSince = new Set(uncovered.map(({ piece }) => piece)).size;
  return { waiting, features, tess: tessDue(features, plan.pieces.every((piece) => isLanded(piece.id))), lastTessSha: lastMark?.sha ?? null, landedSince };
}

/**
 * The `features landed, not checked:` line: each listed feature's pieces landed and risk, then each one waiting for its fix with
 * its verdict, and whether tess is due now.
 */
export function featuresLine({ tess }) {
  const entry = (feature, note) => `${feature.id} ${feature.landed}/${feature.pieces} (risk ${clean(feature.risk)}${note})`;
  const listed = [...tess.features.map((feature) => entry(feature, '')), ...tess.fixing.map((feature) => entry(feature, `, ${feature.verdict}`))];
  const due = tess.reason === null ? `tess due at ${TESS_DUE_AT} (now ${tess.fullyLanded})` : `tess due now (${tess.reason})`;
  return `features landed, not checked: ${listed.length === 0 ? 'none' : listed.join(', ')} -> ${due}`;
}

/**
 * One `commits <feature>: <from8>..<to8> ...` line per feature the features line lists, every land in ledger order: the
 * `commits:` field of that feature's tess brief (gate R4).
 * @param {{ tess: { features: { id: string, lands: { from: string, to: string }[] }[] } }} planState planState's result
 * @returns {string[]} the lines, none when no feature is listed
 */
export function commitsLines({ tess }) {
  return tess.features.map((feature) => `commits ${feature.id}: ${feature.lands.map(({ from, to }) => `${short(from)}..${short(to)}`).join(' ')}`);
}
