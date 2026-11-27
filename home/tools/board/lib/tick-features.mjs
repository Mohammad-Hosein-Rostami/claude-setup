// Purpose: the plan's side of `board tick`: which pieces wait, how far each feature has landed, which features tess has checked,
//   whether a tess round is due, which risky features hold their files until tess returns (plan-core-best cb-hold-1), and the
//   lines that say so.
// Exports: pieceBranch(piece), planState(repo, plan, facts), heldBy(holds, files), featuresLine(planState), commitsLines(planState).
// Invariants: a feature is checked only when it has a tess mark, every ledger `to` of its pieces' branches is an ancestor of the
//   mark's sha (gate R1: a mark's time says nothing about which lands tess saw) and tess recorded `done` with verdict `ok` on that
//   mark (`board done`; plan-core-best cb-done-1): a mark alone, from a tess still running or one that died, checks nothing. A
//   `must-fix` on such a mark is not due again until its fix lands: a piece of the feature after the mark, or any commit on the
//   base since the mark's sha that touches the feature's files (heldFiles; a fix on a branch that is no plan piece). A git call
//   that fails counts as not covered (or as a fix landed), so a doubt always reads `tess due`. A feature is risky when its plan
//   risk is not `none` or the risk tool finds a class (or fails: `unknown`) on one of its lands; a risky feature with a land holds
//   its files until a mark that holds every land has a `done` of either verdict (a `must-fix` frees them for the fix piece), and a
//   git call that cannot list the files of a held or must-fix feature's land throws. A feature tess was started on and has not returned on is not due again while a tess runs (with none running,
//   that tess died). Reads git and runs the risk tool, nothing else; the plan, ledger entries and marks come checked
//   (tick-plan.mjs, land/ledger.mjs).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runGit } from '../../git-tidy/lib/git.mjs';
import { cleanText } from './cells.mjs';

const LANE_PREFIX = 'lane/';
const TESS_DUE_AT = 3; // fully landed features not yet checked that make a tess round due
const NO_RISK = 'none';
const VERDICT_OK = 'ok'; // the one verdict of tick-plan.mjs VERDICTS that checks a feature
const SHORT_SHA = 8;
const RISK_TOOL = fileURLToPath(new URL('../../risk/risk.mjs', import.meta.url));
const RISK_TIMEOUT_MS = 60_000;
const RISK_CLASSIFIED = 0; // risk.mjs exits 0 only with a classified change, `none` included
const RISK_LINE = /^risk: (.+) \(\d+ lines, \d+ files\)$/m; // risk.mjs summaryLine
const UNKNOWN_RISK = 'unknown'; // risk.mjs's word for a change it could not classify: risky (fail closed)
// cleanText reads only `ascii` from a look: these lines keep non-ASCII names as they are and carry no colour
const PLAIN_LOOK = { ascii: false };

const clean = (text) => cleanText(text, PLAIN_LOOK);
const short = (sha) => sha.slice(0, SHORT_SHA);

/** The branch a plan piece is built on: its own `branch` (a `Fix:` on tess-write's `test/<topic>`), else `lane/<piece id>`. */
export const pieceBranch = (piece) => piece.branch ?? `${LANE_PREFIX}${piece.id}`;

/** Whether commit `to` is in the history of `sha`; any failure (an unknown commit, a git error) counts as not covered. */
const isCovered = (repo, to, sha) => runGit(repo.dir, ['merge-base', '--is-ancestor', to, sha]).status === 0;

/** The risk classes of one land (`from`..`to`) by the risk tool: `none`, its classes, or `unknown` when it fails or times out. */
function landRisk(repo, { from, to }) {
  const run = spawnSync(process.execPath, [RISK_TOOL, '--base', from, '--tip', to, '--repo', repo.dir], { encoding: 'utf8', timeout: RISK_TIMEOUT_MS });
  const classes = run.status === RISK_CLASSIFIED ? RISK_LINE.exec(run.stdout)?.[1] : undefined;
  return classes === undefined ? [UNKNOWN_RISK] : classes.split(', ');
}

/** The classes the risk tool finds on any of `lands`, first seen first, as `a, b`; null when every land is `none` (or none landed). */
function landsRisk(repo, lands) {
  const classes = new Set(lands.flatMap((land) => landRisk(repo, land)).filter((name) => name !== NO_RISK));
  return classes.size === 0 ? null : [...classes].join(', ');
}

/**
 * Whether a commit that touches `files` has landed on the base since `sha` (the fix of a must-fix tess recorded there, a plan
 * piece or not); a git call that fails counts as landed, so a doubt reads `tess due`.
 */
function hasLandedOn(repo, sha, files) {
  // --literal-pathspecs: a plan's files are paths, never globs (`app/[id]/page.tsx` must not match `app/i/page.tsx`)
  const listed = runGit(repo.dir, ['--literal-pathspecs', 'rev-list', '-n', '1', `${sha}..${repo.baseRef}`, '--', ...files]);
  return listed.status !== 0 || listed.stdout.trim() !== '';
}

/**
 * One feature's progress: pieces landed, every land of its pieces in ledger order, tess's verdict on a mark whose sha holds all of
 * them (null when there is no such mark or tess has not returned on it), whether that verdict checks the feature, that mark's sha
 * while tess has not returned on it (`tessOn`), and, for a plan risk `none` with no verdict yet, what the risk tool finds on its
 * lands (`riskFound`, null when it finds nothing: the higher of lex's and dev's risk, as qa-plan routes).
 */
function featureState(repo, feature, plan, planLands, mark) {
  const own = new Set(plan.pieces.filter((piece) => piece.feature === feature.id).map((piece) => piece.id));
  // filtered from the ledger-ordered list, never gathered piece by piece: the first range must start at the oldest land (gate R4)
  const lands = planLands.filter(({ piece }) => own.has(piece));
  const landed = new Set(lands.map(({ piece }) => piece)).size;
  const isCoveredAll = mark !== undefined && lands.every(({ to }) => isCovered(repo, to, mark.sha));
  // a verdict counts only on a mark that holds every land: a land after the mark is one tess has not seen
  const markVerdict = isCoveredAll ? (mark.done?.verdict ?? null) : null;
  // a must-fix stops counting once a commit on the feature's files lands after it: its fix, also from a branch no piece names
  const isFixLanded = markVerdict !== null && markVerdict !== VERDICT_OK && hasLandedOn(repo, mark.sha, heldFiles(repo, plan, { lands }));
  const verdict = isFixLanded ? null : markVerdict;
  const tessOn = isCoveredAll && mark.done === undefined ? mark.sha : null;
  const riskFound = feature.risk === NO_RISK && verdict === null ? landsRisk(repo, lands) : null;
  return { id: feature.id, risk: feature.risk, landed, pieces: own.size, lands, verdict, isChecked: verdict === VERDICT_OK, riskFound, tessOn };
}

/** Whether a feature counts as risky: by its plan, or by what the risk tool found on its lands. */
const isRisky = (feature) => feature.risk !== NO_RISK || feature.riskFound !== null;

/**
 * Whether a tess round is due (design section 1, step 5, and the owner's rule for risky features): a risky feature landed and
 * not checked, TESS_DUE_AT features fully landed and not checked, or the job's last piece landed. A landed feature with a
 * `must-fix` verdict waits for its fix (`fixing`): not checked, but never due until its fix lands (featureState drops the
 * verdict then). A feature tess was started on and has not returned on (`underTess`) is not due again while a tess runs: only
 * with none running did that tess die.
 */
function tessDue(features, isJobLanded, isTessRunning) {
  const isUnderTess = (feature) => feature.tessOn !== null && isTessRunning;
  const open = features.filter((feature) => feature.landed > 0 && feature.verdict === null);
  const unchecked = open.filter((feature) => !isUnderTess(feature));
  const fixing = features.filter((feature) => feature.landed > 0 && feature.verdict !== null && !feature.isChecked);
  const risky = unchecked.filter(isRisky);
  const full = unchecked.filter((feature) => feature.landed === feature.pieces);
  let reason = null;
  if (risky.length > 0) reason = `risky ${risky.map((feature) => feature.id).join(', ')}`;
  else if (full.length >= TESS_DUE_AT) reason = `${full.length} features landed`;
  else if (isJobLanded && unchecked.length > 0) reason = 'last piece landed';
  const listed = unchecked.filter((feature) => isRisky(feature) || feature.landed === feature.pieces);
  return { reason, fullyLanded: full.length, features: listed, underTess: open.filter(isUnderTess), fixing };
}

/** The files landed for `feature`: the declared files of its landed pieces and every file its lands changed, sorted, no repeats. */
function heldFiles(repo, plan, feature) {
  const landedIds = new Set(feature.lands.map(({ piece }) => piece));
  const declared = plan.pieces.filter((piece) => landedIds.has(piece.id)).flatMap((piece) => piece.files);
  const changed = feature.lands.flatMap(({ piece, from, to }) => {
    // plumbing (diff-tree), as tick.mjs laneOf: it never runs a textconv or external diff program the repository names
    const listed = runGit(repo.dir, ['diff-tree', '-r', '--name-only', '-z', from, to]);
    if (listed.status !== 0) throw new Error(`git diff-tree failed for the land of piece ${piece} (${short(from)}..${short(to)}): ${listed.stderr}`);
    return listed.stdout.split('\0').filter((path) => path !== '');
  });
  return [...new Set([...declared, ...changed])].sort();
}

/**
 * The holds of one plan: each risky feature with a land and no verdict on a mark that holds every land, with why it waits
 * (`tess not started`: no mark; `landed since its tess mark`: a land the mark does not hold; `tess on it`: the mark holds every
 * land and tess has not returned, `sha` that mark's) and its files (heldFiles).
 */
function holdsOf(repo, plan, features, hasMark) {
  return features.filter((feature) => feature.landed > 0 && feature.verdict === null && isRisky(feature)).map((feature) => {
    let why = 'tess not started';
    if (feature.tessOn !== null) why = 'tess on it';
    else if (hasMark(feature.id)) why = 'landed since its tess mark';
    return { feature: feature.id, why, sha: feature.tessOn, files: heldFiles(repo, plan, feature) };
  });
}

/**
 * The holds on `files`: a piece or lane on any of them waits for tess like the held feature's own files.
 * @param {{ feature: string, files: string[] }[]} holds the holds of every plan the tick reads
 * @param {string[]} files a piece's declared files or a lane's files
 * @returns {string[]} the ids of the held features that share a file with `files`, in hold order, no repeats
 */
export function heldBy(holds, files) {
  return [...new Set(holds.filter((hold) => hold.files.some((path) => files.includes(path))).map((hold) => hold.feature))];
}

/**
 * The plan's side of the tick.
 * @param {{ dir: string, baseRef: string }} repo openRepo's result (git runs there; a must-fix's fix is looked for on baseRef)
 * @param {object} plan readPlan's result
 * @param {object} facts the tick's facts for this plan
 * @param {{ branch: string }[]} facts.lanes the lanes in flight
 * @param {{ branch: string, from: string, to: string }[]} facts.entries the plan's lands in the ledger, oldest first
 * @param {Record<string, { sha: string, at: string, done?: { verdict: string } }>} facts.marks the job's tess marks (readMarks)
 * @param {boolean} facts.isTessRunning whether a tess agent of the session runs now
 * @returns {{ waiting: object[], features: object[], tess: object, holds: object[], lastTessSha: string | null, landedSince: number }}
 *   the waiting pieces (their `after` cut to the unlanded ones), each feature with `lands: [{ piece, from, to }]` in ledger order,
 *   its `verdict`, `riskFound` and `tessOn`, the tess status (`features` listed for tess, `underTess` tess has not returned on,
 *   `fixing` waiting for a fix), the holds (`{ feature, why, sha, files }`), the newest mark's sha and the pieces with a land that
 *   sha does not hold
 * @throws {Error} when git cannot list the files of a held or must-fix feature's land
 */
export function planState(repo, plan, { lanes, entries, marks, isTessRunning }) {
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
  const features = plan.features.map((feature) => featureState(repo, feature, plan, planLands, markOf(feature.id)));
  const lastMark = Object.values(marks).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  const uncovered = planLands.filter(({ to }) => lastMark === null || !isCovered(repo, to, lastMark.sha));
  const landedSince = new Set(uncovered.map(({ piece }) => piece)).size;
  return {
    waiting, features, tess: tessDue(features, plan.pieces.every((piece) => isLanded(piece.id)), isTessRunning),
    holds: holdsOf(repo, plan, features, (id) => markOf(id) !== undefined), lastTessSha: lastMark?.sha ?? null, landedSince,
  };
}

/**
 * The `features landed, not checked:` line: each listed feature's pieces landed and risk (`none -> <classes>` when the risk tool
 * found some), then each one tess is on, then each one waiting for its fix with its verdict, and whether tess is due now.
 */
export function featuresLine({ tess }) {
  const risk = (feature) => `${clean(feature.risk)}${feature.riskFound === null ? '' : ` -> ${clean(feature.riskFound)}`}`;
  const entry = (feature, note) => `${feature.id} ${feature.landed}/${feature.pieces} (risk ${risk(feature)}${note})`;
  const listed = [
    ...tess.features.map((feature) => entry(feature, '')), ...tess.underTess.map((feature) => entry(feature, ', tess on it')),
    ...tess.fixing.map((feature) => entry(feature, `, ${feature.verdict}`)),
  ];
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
