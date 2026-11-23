// Purpose: line 4 of the road gate (road-gate.mjs): the UI proof of a step, by the landings' check plans, on the web path or on the
//   terminal path; and whether a step needs its step-start record (`road.mjs next`, the web path's baseline).
// Exports: uiLine(road, rows, ranges, step, ctx) -> one PASS or FAIL line; stepNeedsBaseline(road, step) -> boolean;
//   TERMINAL_PROOF_SUFFIX; setupReportsFolder().
// Plan path (ui-kinds-spec.md section 3): land-lane computes each landing's check plan on the rebased diff and, once `ui-proof check
//   --plan` proved it, ends the landing row's evidence with ` (ui plan <depth>: proved)` (ui-evidence.mjs planEvidence). When every
//   landing of the step that changed a UI file is proved so with a depth other than pixel, line 4 PASSes as proved by their plan. The
//   suffix is read only from the landing row land-lane wrote (or its one done correction row, which holds the evidence land-lane printed),
//   never from a lane report, and it is only a pointer (STATUS text anyone can type): line 4 confirms it from the tool's own records with
//   `ui-proof check --tip <to> --plan --base <from> [--matrix <lane matrix>]` for that landing's range, and FAILs when that call does not
//   exit 0. A confirmed plan that prints no `plan: <depth>` line (ui-proof prints today's visual-qa check for a visual or pixel plan) or
//   prints pixel takes the web path. Zero landings that changed a UI file is never "proved". A pixel landing or a UI landing with no
//   suffix (older landings included) takes the web path, for the whole step; landings proved by their plan then need no step-start record.
// Web path (owner standard: pixel-perfect web UI, never weakened): when any landing range of the step (a lane's or a fix row's
//   `<road>.s<N>.fix-<name>`) changes UI files (`ui-proof changed` exit 1) or a lane has a coverage matrix path, a visual-qa PASS at the
//   tip. When the step needs its step-start record (stepNeedsBaseline, the one rule `road.mjs next` asks it by, so the two never
//   disagree): `ui-proof check --tip <tip> --against-step <road>.s<N>` exit 0 and the record taken at or before every `<from>`, except a
//   range proved by its plan, or a range that ended at or before it from a row that is no UI lane and changed no UI file (landed early:
//   its work is in the record). Otherwise `ui-proof check --tip <tip>` exit 0: no record is asked that `next` said was not needed. UI
//   checks always run (owner decision CR5).
// Baseline (`next` and line 4): a step needs its step-start record when a lane of it has a coverage matrix with Figma frames (a `figma`
//   section or a non-empty `frames` list: the pixel chain). A matrix path that cannot be read as JSON, or a JSON value of the wrong shape
//   (not an object, `figma` not an object, `frames` not a list), counts as one (fail closed). Lanes with UI files and no such matrix are
//   proved by their plan at land time, or by a visual-qa PASS at the step tip.
// Terminal path: a step whose UI is text in a terminal (every lane with a matrix says `none: <reason>`, and no landing range of the step
//   changed a UI file: the status line and board renderers are `.mjs` that print rows) has no web page for visual-qa to check, so its
//   proof is the owner's yes on a real render: a done STATUS row `<road>.s<N>.terminal-proof` whose evidence is exactly
//   `terminal proof: <absolute path of the real-render file> (owner yes <YYYY-MM-DD>)`, where the file (real path) lies in the job's folder
//   (beside STATUS.md) or the setup reports tree `~/Desktop/claude-setup-reports/` (no environment override), is a non-empty file written at or after the start of
//   the step's first landing row, the date is a real day not after today (UTC), and the owner's yes is on record: the lead asks it with
//   AskUserQuestion and records the answer with `status.mjs decision`, so `## Owner decisions` holds the bullet
//   `- <same date> terminal proof <road>.s<N>: owner yes on <same path> (AskUserQuestion answer)` (status.mjs writes the date; a timeout
//   default, `UNCONFIRMED ...`, is no such bullet). A step with any UI file changed or any matrix path never takes this path.
// No waiver (owner R28, 2026-11-23: no kinds, no waivers): a landing that ends with the old ` (ui-proof waived: owner decision)` is no
//   plan proof, so its step takes the web or terminal path.
// Invariants: every exit other than the expected ones is FAIL (fail closed); `ctx.uiProof(argv)` runs the ui-proof tool and
//   `ctx.isAncestor(a, b)` git's `merge-base --is-ancestor` exit, both with their timeouts (road-gate.mjs), so tests inject them.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { findSection } from '../../estimate/lib/items.mjs';
import { DEPTHS, planEvidence } from '../../ui-proof/lib/ui-evidence.mjs';
import { correctionRows, isUiLane, landedLine } from './road-state.mjs';

export const TERMINAL_PROOF_SUFFIX = '.terminal-proof';
const NO_MATRIX = 'none:'; // road-file.mjs: a lane with no coverage matrix says `none: <reason>`
const TERMINAL_PROOF = /^terminal proof: (.+) \(owner yes (\d{4}-\d{2}-\d{2})\)$/;
const RECORD_AT = /\bat ([0-9a-f]{7,40})\b/;
const SETUP_REPORTS = ['Desktop', 'claude-setup-reports']; // under HOME: the setup's default reports tree (docs/daily-use.md)
const OWNER_DECISIONS = 'Owner decisions'; // the STATUS.md section status.mjs `decision` writes to
const DECISION_BULLET = /^- (\d{4}-\d{2}-\d{2}) terminal proof (\S+): owner yes on (.+) \(AskUserQuestion answer\)$/;
const PIXEL = 'pixel'; // the full Figma chain: its landings need the web path's visual-qa step proof, whatever their suffix says
const PLAN_LINE = /^plan: (\S+)$/m; // the depth `ui-proof check --plan` printed for the range (none for a visual or pixel plan)
const NOT_BY_PLAN = Object.freeze({ byPlan: false, problem: null });

const pass = (text) => `PASS ${text}`;
const fail = (text) => `FAIL ${text}`;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * True when the step-start record `at` was taken at or before the range's `from`, the range is proved by its plan, or the range (no UI
 * lane, no UI file) ended at or before it.
 */
function recordCovers(ctx, at, range, { uiChanged, byPlan }) {
  if (byPlan || ctx.isAncestor(at, range.landed.from) === 0) return true;
  const uiLane = range.entry !== null && isUiLane(range.entry.lane, ctx.isUiPath); // a fix row (no entry) is no lane: its own range counts
  return !uiChanged && !uiLane && ctx.isAncestor(range.landed.to, at) === 0;
}

/**
 * The setup reports tree a terminal proof may lie in: always `~/Desktop/claude-setup-reports` under HOME. No environment variable
 * moves it: a project's `.claude/settings.json` can set env for the whole session, so an override would let a project widen the
 * folders the gate accepts to one holding a planted proof. A person who keeps reports elsewhere puts the proof in the job's folder
 * (beside STATUS.md), which the gate always accepts.
 * @returns {{folder: string, shown: string}} the folder, and how a FAIL line names it
 */
export function setupReportsFolder() {
  return { folder: join(homedir(), ...SETUP_REPORTS), shown: join('~', ...SETUP_REPORTS) };
}

/** The real path of a folder or file, or null when it does not exist. */
function realPathOrNull(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** The earliest start of the step's landing rows (ms), or null when none of them has started. */
function stepStartMs(rows, own) {
  const starts = own.map((range) => rows.get(range.row.toLowerCase())?.started).filter((started) => typeof started === 'number');
  return starts.length === 0 ? null : Math.min(...starts);
}

/**
 * Why the named render cannot be the proof, or null: it must exist, lie (real path, so no link leads out) in the job's folder or the
 * setup reports tree, be a non-empty file, and be written at or after the step's first landing row started.
 */
function renderFileProblem(path, ctx, startMs) {
  const real = realPathOrNull(path);
  const reports = setupReportsFolder();
  const folders = [ctx.statusFile === undefined ? null : dirname(ctx.statusFile), reports.folder];
  const allowed = folders.filter((folder) => folder !== null).map(realPathOrNull).filter((folder) => folder !== null);
  const found = real === null ? null : statSync(real);
  if (found === null || !found.isFile() || found.size === 0) return `names ${path}, which is not a non-empty file`;
  if (!allowed.some((folder) => real.startsWith(`${folder}${sep}`))) return `names ${path}, which lies outside the job's folder and ${reports.shown}`;
  if (startMs === null) return 'has no started landing row of the step to date the render against';
  if (found.mtimeMs < startMs) return `names ${path}, written before the step's first landing row started (${new Date(startMs).toISOString()})`;
  return null;
}

/** Why the owner-yes date cannot be right, or null: a real calendar day, not after today (UTC). */
function dateProblem(date, nowMs) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms) || day(ms) !== date) return `says owner yes ${date}, which is not a real date`;
  if (date > day(nowMs)) return `says owner yes ${date}, a date after today`;
  return null;
}

/** Why the owner's yes is not on record, or null: `## Owner decisions` must hold the bullet for this step, path and date. */
function decisionProblem(statusText, label, path, date) {
  const lines = statusText.split(/\r?\n/);
  const section = findSection(lines, OWNER_DECISIONS);
  const bullets = section.start === -1 ? [] : lines.slice(section.start + 1, section.end).filter((_, i) => section.visible[section.start + 1 + i]);
  const recorded = bullets.map((line) => DECISION_BULLET.exec(line.trim()))
    .some((match) => match !== null && match[1] === date && match[2].toLowerCase() === label.toLowerCase() && match[3] === path);
  if (recorded) return null;
  return `has no owner decision on record: \`## ${OWNER_DECISIONS}\` needs "- ${date} terminal proof ${label}: owner yes on ${path} (AskUserQuestion answer)" (status.mjs decision)`;
}

/** The terminal path: the step's `<label>.terminal-proof` row, done, names an owner-approved real-render file (header: every condition). */
function terminalProofLine(rows, label, own, ctx) {
  const id = `${label}${TERMINAL_PROOF_SUFFIX}`;
  const format = '"terminal proof: <absolute path of the real render> (owner yes <YYYY-MM-DD>)"';
  const row = rows.get(id.toLowerCase());
  if (row?.done == null) return fail(`4 ui: terminal UI step: no owner-approved terminal proof; the record is a done row ${id} with the evidence ${format}`);
  const match = TERMINAL_PROOF.exec(String(row.evidence ?? '').trim());
  if (match === null || !isAbsolute(match[1])) return fail(`4 ui: ${id} evidence is not ${format}`);
  const [, path, date] = match;
  const problem = renderFileProblem(path, ctx, stepStartMs(rows, own)) ?? dateProblem(date, Date.now()) ?? decisionProblem(ctx.statusText ?? '', label, path, date);
  if (problem !== null) return fail(`4 ui: ${id} ${problem}`);
  return pass(`4 ui: terminal UI step: real render ${path} approved by the owner on ${date}`);
}

/** The evidence that holds the range's landed line: the row's own, else its one done correction row's (as road-gate.mjs reads it). */
function landingEvidence(rows, id) {
  const own = rows.get(id.toLowerCase());
  if (landedLine(own?.evidence) !== null) return String(own.evidence);
  const found = correctionRows(rows, id);
  return found.length === 1 && found[0].done != null ? String(found[0].evidence ?? '') : '';
}

/** The plan depth the landing's evidence ends with (` (ui plan <depth>: proved)`, written by land-lane), or null when it ends with none. */
function provedDepth(rows, id) {
  const evidence = landingEvidence(rows, id).trimEnd();
  return DEPTHS.find((depth) => evidence.endsWith(planEvidence(depth))) ?? null;
}

/**
 * Whether a UI landing is proved by its plan. Its row's suffix (a depth other than pixel) is only a pointer: `ui-proof check --plan` for
 * the landing's own range must confirm it from the tool's records, and a plan it prints as pixel, or with no depth line, is no plan proof.
 * @returns {{ byPlan: boolean, problem: string | null }} problem: the confirming call failed (line 4 FAILs with it)
 */
function planProof(rows, range, ctx) {
  const claimed = provedDepth(rows, range.row);
  if (claimed === null || claimed === PIXEL) return NOT_BY_PLAN;
  const matrix = range.entry?.lane.matrix;
  const matrixArgs = typeof matrix === 'string' && !matrix.startsWith(NO_MATRIX) ? ['--matrix', resolve(ctx.repo, matrix)] : [];
  const argv = ['check', '--tip', range.landed.to, '--plan', '--base', range.landed.from, ...matrixArgs, '--repo', ctx.repo];
  const result = ctx.uiProof(argv);
  if (result.exit !== 0) {
    return { byPlan: false, problem: `${range.row} ends with "${planEvidence(claimed).trim()}" but ui-proof check --plan --base ${range.landed.from} --tip ${range.landed.to} exited ${result.exit}` };
  }
  const depth = PLAN_LINE.exec(result.out)?.[1];
  return { byPlan: DEPTHS.includes(depth) && depth !== PIXEL, problem: null };
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True when a matrix file reads as JSON with Figma frames: a `figma` section or a non-empty `frames` list. The keys read are checked for
 * shape first (C10): a value that is not an object, a `figma` that is not an object or a `frames` that is not a list counts as frames,
 * like a file that cannot be read or parsed (fail closed: the step keeps its baseline).
 */
function matrixHasFigma(path) {
  let matrix;
  try {
    matrix = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return true; // a missing, unreadable or broken matrix cannot show it has no frames, so the step keeps its baseline
  }
  const sound = isPlainObject(matrix) && (matrix.figma === undefined || isPlainObject(matrix.figma))
    && (matrix.frames === undefined || Array.isArray(matrix.frames));
  if (!sound) return true;
  return matrix.figma !== undefined || (matrix.frames !== undefined && matrix.frames.length > 0);
}

/**
 * Whether a step needs its step-start record: a lane of it has a coverage matrix path (not `none: <reason>`) whose matrix has Figma
 * frames, cannot be read or has the wrong shape. The one rule for both `road.mjs next` (asks the record) and line 4's web path (checks
 * it), so the two cannot disagree. A relative matrix path is read from the road's repo.
 * @param {object} road a checked road
 * @param {number} step 1-based
 * @returns {boolean}
 */
export function stepNeedsBaseline(road, step) {
  return road.steps[step - 1].lanes.map((lane) => lane.matrix).filter((matrix) => typeof matrix === 'string' && !matrix.startsWith(NO_MATRIX))
    .some((matrix) => matrixHasFigma(resolve(road.repo, matrix)));
}

/**
 * Line 4: the UI proof of the step.
 * @param {object} road a checked road
 * @param {Map<string, object>} rows the STATUS rows by lower-case id
 * @param {object[]} ranges this road's resolved close ranges (road-gate.mjs; `step` set for lanes and fix rows), never another road's
 * @param {number} step 1-based
 * @param {{ tip: string, repo: string, isUiPath: (path: string) => boolean, uiProof: (argv: string[]) => { exit: number, out: string },
 *   isAncestor: (a: string, b: string) => number, statusFile?: string, statusText?: string }} ctx the road's STATUS.md path and text
 *   for the terminal proof (its folder and its owner decisions)
 * @returns {string} one PASS or FAIL line
 */
export function uiLine(road, rows, ranges, step, ctx) {
  // Every landing of the step, a fix row's included: a fix that lands a web UI file needs ui-proof check like a lane does.
  const own = ranges.filter((range) => range.step === step && range.unknown.length === 0 && range.landed?.from);
  const matrices = road.steps[step - 1].lanes.map((lane) => lane.matrix).filter((matrix) => typeof matrix === 'string');
  const changed = own.map((range) => ctx.uiProof(['changed', '--from', range.landed.from, '--to', range.landed.to, '--repo', ctx.repo]));
  if (changed.some((result) => result.exit !== 0 && result.exit !== 1)) return fail('4 ui: ui-proof changed could not answer');
  const uiChanged = changed.some((result) => result.exit === 1);
  if (matrices.length === 0 && !uiChanged) return pass('4 ui: no UI file changed in the step');
  const plans = own.map((range, index) => (changed[index].exit === 1 ? planProof(rows, range, ctx) : NOT_BY_PLAN));
  const unconfirmed = plans.find((plan) => plan.problem !== null);
  if (unconfirmed !== undefined) return fail(`4 ui: ${unconfirmed.problem}`);
  const byPlan = plans.map((plan) => plan.byPlan);
  const proved = byPlan.filter(Boolean).length;
  if (proved > 0 && changed.every((result, index) => result.exit !== 1 || byPlan[index])) return pass(`4 ui: ${proved} landing(s) proved by their plan`);
  const label = `${road.road}.s${step}`;
  if (!uiChanged && matrices.every((matrix) => matrix.startsWith(NO_MATRIX))) return terminalProofLine(rows, label, own, ctx);
  return webLine(own, { label, changed, byPlan, proved, baseline: stepNeedsBaseline(road, step) }, ctx);
}

/**
 * The web path: a visual-qa PASS at the tip; when the step needs its step-start record (`baseline`, stepNeedsBaseline), no state worse
 * than that record and the record taken at or before every from (recordCovers). Without it no record is asked: `next` asked none.
 */
function webLine(own, { label, changed, byPlan, proved, baseline }, ctx) {
  const planned = proved === 0 ? '' : `; ${proved} landing(s) proved by their plan`;
  if (!baseline) {
    const proof = ctx.uiProof(['check', '--tip', ctx.tip, '--repo', ctx.repo]);
    if (proof.exit !== 0) return fail(`4 ui: ui-proof check --tip ${ctx.tip} exited ${proof.exit}`);
    return pass(`4 ui: visual-qa PASS at ${ctx.tip} (no lane matrix of the step has Figma frames: next asked no baseline)${planned}`);
  }
  const proof = ctx.uiProof(['check', '--tip', ctx.tip, '--against-step', label, '--repo', ctx.repo]);
  if (proof.exit !== 0) return fail(`4 ui: ui-proof check --against-step ${label} exited ${proof.exit}`);
  const at = RECORD_AT.exec(ctx.uiProof(['has', '--step', label, '--repo', ctx.repo]).out)?.[1];
  const covered = (range, index) => recordCovers(ctx, at, range, { uiChanged: changed[index].exit === 1, byPlan: byPlan[index] });
  if (at === undefined || !own.every(covered)) return fail(`4 ui: the step-start record ${label} was not taken at or before every from`);
  return pass(`4 ui: visual-qa PASS at ${ctx.tip}, no state worse than ${label}${planned}`);
}
