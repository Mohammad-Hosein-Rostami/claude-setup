// Purpose: the one definition of the owner's ui-proof waiver for a road (owner decision 2026-11-23: web API-integration lanes land
//   without the visual-qa PASS, every other check stays). `git-tidy land`, `land-lane` and the road gate's line 4 all read it here.
// Exports: UI_WAIVER_EVIDENCE, MAX_WAIVER_REASON_CHARS, roadOfRow, waiverReasonProblem, ownerWaiverLine, ownerWaiverProblem.
// Rule: a waiver holds for road <id> only when the STATUS.md section `## Owner decisions` (up to the next heading, lines inside a code
//   fence not counted) has a line containing `ui-proof waiver for road <id>`, the id followed by no further id character, and the line does
//   not contain UNCONFIRMED (a decision taken by a timeout default is no owner decision). Nothing else turns the UI proof off.
// Invariants: reads only; a STATUS.md that cannot be read is a problem (the waiver does not hold), never a pass.
import { findSection } from '../../estimate/lib/items.mjs';
import { readStatusFile } from '../../status/status-file.mjs';

/** The text a landing row's evidence ends with when it landed under the waiver (land-lane writes it, the road gate reads it). */
export const UI_WAIVER_EVIDENCE = ' (ui-proof waived: owner decision)';
export const MAX_WAIVER_REASON_CHARS = 200; // the same rule as land-lane's --skip-review reason

const OWNER_DECISIONS = 'Owner decisions'; // the section status.mjs `decision` writes to
const ROAD_ID = /^[a-z][a-z0-9-]{0,7}$/; // road-file.mjs ROAD_ID
const ROAD_ROW = /^([a-z][a-z0-9-]{0,7})\.s[1-9]\d*\.[\w.:-]+$/; // `<road>.s<N>.<name>`, the road id as ROAD_ID
const UNCONFIRMED = /UNCONFIRMED/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The road id of a road row id (`iceweb.s1.fe-session` -> `iceweb`), or null for a row that is no road row.
 * @param {string} rowId a STATUS.md row id
 * @returns {string|null}
 */
export const roadOfRow = (rowId) => ROAD_ROW.exec(rowId)?.[1] ?? null;

/**
 * Why a waiver reason is not usable, or null: 1 to MAX_WAIVER_REASON_CHARS characters, no control character (it is printed and logged).
 * @param {string} reason the text given with --owner-waive-ui
 * @returns {string|null}
 */
export function waiverReasonProblem(reason) {
  if (reason.length >= 1 && reason.length <= MAX_WAIVER_REASON_CHARS && !CONTROL_CHARACTER.test(reason)) return null;
  return `--owner-waive-ui needs a reason of 1 to ${MAX_WAIVER_REASON_CHARS} characters with no control characters, got ${reason.length} characters`;
}

/**
 * The owner's waiver line for `road` in the STATUS.md text, or null when there is none (see the rule in the header).
 * @param {string} statusText the whole STATUS.md
 * @param {string} road the road id
 * @returns {string|null} the line, trimmed
 */
export function ownerWaiverLine(statusText, road) {
  const lines = statusText.split(/\r?\n/);
  const section = findSection(lines, OWNER_DECISIONS);
  if (section.start === -1) return null;
  const phrase = new RegExp(`ui-proof waiver for road ${escapeRegExp(road)}(?![\\w-])`);
  for (let i = section.start + 1; i < section.end; i += 1) {
    if (section.visible[i] && phrase.test(lines[i]) && !UNCONFIRMED.test(lines[i])) return lines[i].trim();
  }
  return null;
}

/**
 * Why the waiver does not hold for `road` in the STATUS.md at `statusFile`, or null when the owner's line is there.
 * @param {string} statusFile absolute path of the STATUS.md (read without following a link)
 * @param {string} road the road id
 * @returns {string|null} the problem, naming the missing decision line
 */
export function ownerWaiverProblem(statusFile, road) {
  if (!ROAD_ID.test(road)) return `--owner-waive-ui: ${JSON.stringify(road)} is not a road id (${ROAD_ID})`;
  let read;
  try {
    read = readStatusFile(statusFile);
  } catch (error) {
    return `--owner-waive-ui: ${statusFile} cannot be read (${error.message}), so the owner's decision cannot be checked`;
  }
  if (read.refused !== undefined) return `--owner-waive-ui: ${statusFile} ${read.refused}, so the owner's decision cannot be checked`;
  if (ownerWaiverLine(read.text, road) !== null) return null;
  return `--owner-waive-ui: no owner decision for road ${road}: \`## ${OWNER_DECISIONS}\` in ${statusFile} needs a line with "ui-proof waiver for road ${road}"`
    + ' (the owner\'s own answer, recorded with status.mjs decision; a line with UNCONFIRMED does not count)';
}
