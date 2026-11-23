// Purpose: line 4 of the road gate (road-gate.mjs): the UI proof of a step, on the web path or on the terminal path.
// Exports: uiLine(road, rows, ranges, step, ctx) -> one PASS or FAIL line; TERMINAL_PROOF_SUFFIX.
// Web path (owner standard: pixel-perfect web UI, never weakened): when any landing range of the step (a lane's or a fix row's
//   `<road>.s<N>.fix-<name>`) changes UI files (`ui-proof changed` exit 1) or a lane has a coverage matrix path,
//   `ui-proof check --tip <tip> --against-step <road>.s<N>` exit 0 and the step-start record taken at or before every `<from>`, except a
//   range that ended at or before it from a row that is no UI lane and changed no UI file (landed early: its work is in the record). UI
//   checks always run (owner decision CR5).
// Terminal path: a step whose UI is text in a terminal (every lane with a matrix says `none: <reason>`, and no landing range of the step
//   changed a UI file: the status line and board renderers are `.mjs` that print rows) has no web page for visual-qa to check, so its
//   proof is the owner's yes on a real render: a done STATUS row `<road>.s<N>.terminal-proof` whose evidence is exactly
//   `terminal proof: <absolute path of the real-render file> (owner yes <YYYY-MM-DD>)`, where the file (real path) lies in the job's folder
//   (beside STATUS.md) or the setup reports tree `~/Desktop/claude-setup-reports/`, is a non-empty file written at or after the start of
//   the step's first landing row, the date is a real day not after today (UTC), and the owner's yes is on record: the lead asks it with
//   AskUserQuestion and records the answer with `status.mjs decision`, so `## Owner decisions` holds the bullet
//   `- <same date> terminal proof <road>.s<N>: owner yes on <same path> (AskUserQuestion answer)` (status.mjs writes the date; a timeout
//   default, `UNCONFIRMED ...`, is no such bullet). A step with any UI file changed or any matrix path never takes this path.
// Owner waiver (owner decision 2026-11-23, web API-integration lanes): before both paths, a step PASSes as "waived by owner decision" when
//   a landing of it ends its evidence with ` (ui-proof waived: owner decision)` (land-lane --owner-waive-ui), every landing that changed a
//   UI file does too, and `## Owner decisions` holds the owner's `ui-proof waiver for road <road>` line (no UNCONFIRMED). Anything less
//   leaves the step to the paths above, unchanged.
// Invariants: every exit other than the expected ones is FAIL (fail closed); `ctx.uiProof(argv)` runs the ui-proof tool and
//   `ctx.isAncestor(a, b)` git's `merge-base --is-ancestor` exit, both with their timeouts (road-gate.mjs), so tests inject them.
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { findSection } from '../../estimate/lib/items.mjs';
import { UI_WAIVER_EVIDENCE, ownerWaiverLine } from '../../ui-proof/lib/owner-waiver.mjs';
import { correctionRows, isUiLane, landedLine } from './road-state.mjs';

export const TERMINAL_PROOF_SUFFIX = '.terminal-proof';
const NO_MATRIX = 'none:'; // road-file.mjs: a lane with no coverage matrix says `none: <reason>`
const TERMINAL_PROOF = /^terminal proof: (.+) \(owner yes (\d{4}-\d{2}-\d{2})\)$/;
const RECORD_AT = /\bat ([0-9a-f]{7,40})\b/;
const SETUP_REPORTS = ['Desktop', 'claude-setup-reports']; // under HOME: the setup's reports tree (docs/daily-use.md)
const OWNER_DECISIONS = 'Owner decisions'; // the STATUS.md section status.mjs `decision` writes to
const DECISION_BULLET = /^- (\d{4}-\d{2}-\d{2}) terminal proof (\S+): owner yes on (.+) \(AskUserQuestion answer\)$/;

const pass = (text) => `PASS ${text}`;
const fail = (text) => `FAIL ${text}`;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** True when the step-start record `at` was taken at or before the range's `from`, or the range (no UI lane, no UI file) ended at or before it. */
function recordCovers(ctx, at, range, uiChanged) {
  if (ctx.isAncestor(at, range.landed.from) === 0) return true;
  const uiLane = range.entry !== null && isUiLane(range.entry.lane, ctx.isUiPath); // a fix row (no entry) is no lane: its own range counts
  return !uiChanged && !uiLane && ctx.isAncestor(range.landed.to, at) === 0;
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
  const folders = [ctx.statusFile === undefined ? null : dirname(ctx.statusFile), join(homedir(), ...SETUP_REPORTS)];
  const allowed = folders.filter((folder) => folder !== null).map(realPathOrNull).filter((folder) => folder !== null);
  const found = real === null ? null : statSync(real);
  if (found === null || !found.isFile() || found.size === 0) return `names ${path}, which is not a non-empty file`;
  if (!allowed.some((folder) => real.startsWith(`${folder}${sep}`))) return `names ${path}, which lies outside the job's folder and ${join('~', ...SETUP_REPORTS)}`;
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

/**
 * The owner's waiver of the step's UI proof, or null when it does not apply: some landing of the step ends its evidence with
 * UI_WAIVER_EVIDENCE (land-lane --owner-waive-ui), every landing that changed a UI file does, and `## Owner decisions` holds the owner's
 * line for this road (ui-proof/lib/owner-waiver.mjs; an UNCONFIRMED line is none). Otherwise the web or terminal path decides as before.
 */
function waiverLine(road, rows, own, changed, ctx) {
  const waived = own.map((range) => landingEvidence(rows, range.row).trimEnd().endsWith(UI_WAIVER_EVIDENCE));
  if (!waived.includes(true) || changed.some((result, index) => result.exit === 1 && !waived[index])) return null;
  if (ownerWaiverLine(ctx.statusText ?? '', road.road) === null) return null;
  const count = waived.filter(Boolean).length;
  return pass(`4 ui: waived by owner decision (ui-proof waiver for road ${road.road}): ${count} landing(s) of the step landed with --owner-waive-ui`);
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
  const waived = waiverLine(road, rows, own, changed, ctx);
  if (waived !== null) return waived;
  const label = `${road.road}.s${step}`;
  if (!uiChanged && matrices.every((matrix) => matrix.startsWith(NO_MATRIX))) return terminalProofLine(rows, label, own, ctx);
  const proof = ctx.uiProof(['check', '--tip', ctx.tip, '--against-step', label, '--repo', ctx.repo]);
  if (proof.exit !== 0) return fail(`4 ui: ui-proof check --against-step ${label} exited ${proof.exit}`);
  const at = RECORD_AT.exec(ctx.uiProof(['has', '--step', label, '--repo', ctx.repo]).out)?.[1];
  if (at === undefined || own.some((range, index) => !recordCovers(ctx, at, range, changed[index].exit === 1))) return fail(`4 ui: the step-start record ${label} was not taken at or before every from`);
  return pass(`4 ui: visual-qa PASS at ${ctx.tip}, no state worse than ${label}`);
}
