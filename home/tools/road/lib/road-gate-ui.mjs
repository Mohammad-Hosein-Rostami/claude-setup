// Purpose: line 4 of the road gate (road-gate.mjs): the UI proof of a step, on the web path or on the terminal path.
// Exports: uiLine(road, rows, ranges, step, ctx) -> one PASS or FAIL line; TERMINAL_PROOF_SUFFIX.
// Web path (unchanged; owner standard: pixel-perfect web UI): when a range of the step changes UI files (`ui-proof changed` exit 1) or a
//   lane has a coverage matrix path, `ui-proof check --tip <tip> --against-step <road>.s<N>` exit 0 and the step-start record taken at or
//   before every `<from>`, except a range that ended at or before it from a lane that is no UI lane and changed no UI file (landed early:
//   its work is in the record). UI checks always run (owner decision CR5).
// Terminal path: a step whose UI is text in a terminal (every lane with a matrix says `none: <reason>`, and no range changed a UI file:
//   the status line and board renderers are `.mjs` that print rows) has no web page for visual-qa to check, so its proof is the owner's
//   yes on a real render: a done STATUS row `<road>.s<N>.terminal-proof` whose evidence is exactly
//   `terminal proof: <absolute path of the real-render file> (owner yes <YYYY-MM-DD>)`, and that path a non-empty file. A step with any
//   UI file changed or any matrix path never takes this path.
// Invariants: every exit other than the expected ones is FAIL (fail closed); `ctx.uiProof(argv)` runs the ui-proof tool and
//   `ctx.isAncestor(a, b)` git's `merge-base --is-ancestor` exit, both with their timeouts (road-gate.mjs), so tests inject them.
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isUiLane } from './road-state.mjs';

export const TERMINAL_PROOF_SUFFIX = '.terminal-proof';
const NO_MATRIX = 'none:'; // road-file.mjs: a lane with no coverage matrix says `none: <reason>`
const TERMINAL_PROOF = /^terminal proof: (.+) \(owner yes (\d{4}-\d{2}-\d{2})\)$/;
const RECORD_AT = /\bat ([0-9a-f]{7,40})\b/;

const pass = (text) => `PASS ${text}`;
const fail = (text) => `FAIL ${text}`;

/** True when the step-start record `at` was taken at or before the range's `from`, or the range (no UI lane, no UI file) ended at or before it. */
function recordCovers(ctx, at, range, uiChanged) {
  if (ctx.isAncestor(at, range.landed.from) === 0) return true;
  return !uiChanged && !isUiLane(range.entry.lane, ctx.isUiPath) && ctx.isAncestor(range.landed.to, at) === 0;
}

/** True when the path names a regular file with content (a render the owner looked at, not an empty placeholder). */
function isRenderFile(path) {
  try {
    const found = statSync(path);
    return found.isFile() && found.size > 0;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** The terminal path: the step's `<label>.terminal-proof` row, done, names an owner-approved real-render file. */
function terminalProofLine(rows, label) {
  const id = `${label}${TERMINAL_PROOF_SUFFIX}`;
  const format = '"terminal proof: <absolute path of the real render> (owner yes <YYYY-MM-DD>)"';
  const row = rows.get(id.toLowerCase());
  if (row?.done == null) return fail(`4 ui: terminal UI step: no owner-approved terminal proof; the record is a done row ${id} with the evidence ${format}`);
  const match = TERMINAL_PROOF.exec(String(row.evidence ?? '').trim());
  if (match === null || !isAbsolute(match[1])) return fail(`4 ui: ${id} evidence is not ${format}`);
  if (!isRenderFile(match[1])) return fail(`4 ui: ${id} names ${match[1]}, which is not a non-empty file`);
  return pass(`4 ui: terminal UI step: real render ${match[1]} approved by the owner on ${match[2]}`);
}

/**
 * Line 4: the UI proof of the step.
 * @param {object} road a checked road
 * @param {Map<string, object>} rows the STATUS rows by lower-case id
 * @param {object[]} ranges this road's resolved close ranges (road-gate.mjs), never another road's
 * @param {number} step 1-based
 * @param {{ tip: string, repo: string, isUiPath: (path: string) => boolean, uiProof: (argv: string[]) => { exit: number, out: string },
 *   isAncestor: (a: string, b: string) => number }} ctx
 * @returns {string} one PASS or FAIL line
 */
export function uiLine(road, rows, ranges, step, ctx) {
  const own = ranges.filter((range) => range.entry?.step === step && range.unknown.length === 0 && range.landed?.from);
  const matrices = road.steps[step - 1].lanes.map((lane) => lane.matrix).filter((matrix) => typeof matrix === 'string');
  const changed = own.map((range) => ctx.uiProof(['changed', '--from', range.landed.from, '--to', range.landed.to, '--repo', ctx.repo]));
  if (changed.some((result) => result.exit !== 0 && result.exit !== 1)) return fail('4 ui: ui-proof changed could not answer');
  const uiChanged = changed.some((result) => result.exit === 1);
  if (matrices.length === 0 && !uiChanged) return pass('4 ui: no UI file changed in the step');
  const label = `${road.road}.s${step}`;
  if (!uiChanged && matrices.every((matrix) => matrix.startsWith(NO_MATRIX))) return terminalProofLine(rows, label);
  const proof = ctx.uiProof(['check', '--tip', ctx.tip, '--against-step', label, '--repo', ctx.repo]);
  if (proof.exit !== 0) return fail(`4 ui: ui-proof check --against-step ${label} exited ${proof.exit}`);
  const at = RECORD_AT.exec(ctx.uiProof(['has', '--step', label, '--repo', ctx.repo]).out)?.[1];
  if (at === undefined || own.some((range, index) => !recordCovers(ctx, at, range, changed[index].exit === 1))) return fail(`4 ui: the step-start record ${label} was not taken at or before every from`);
  return pass(`4 ui: visual-qa PASS at ${ctx.tip}, no state worse than ${label}`);
}
