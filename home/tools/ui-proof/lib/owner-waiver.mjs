// Purpose: the one definition of the owner's ui-proof waiver for a road (owner decision 2026-11-23: web API-integration lanes land
//   without the visual-qa PASS, every other check stays). `git-tidy land`, `land-lane` and the road gate's line 4 all read it here.
// Exports: UI_WAIVER_EVIDENCE, MAX_WAIVER_REASON_CHARS, roadOfRow, waiverReasonProblem, ownerWaiverLine, ownerWaiverProblem.
// Rule: in the STATUS.md section `## Owner decisions` (up to the next heading; lines in a code fence and text in an HTML comment
//   `<!-- -->` do not count), the last visible line that names `ui-proof waiver for road <id>` (any case, the id followed by no further
//   id character) decides. It grants the waiver only in the form `- [YYYY-MM-DD ]ui-proof waiver for road <id>[<rest>]` (the bullet
//   status.mjs `decision` writes, the phrase first), with no UNCONFIRMED on the line and no negation word in <rest>. Any other line
//   naming it (`- <date> ui-proof waiver for road <id> revoked`, `- <date> no ui-proof waiver for road <id>`, ...) revokes. For a landing
//   the STATUS.md must also hold the close row and lie outside every folder of the repository being landed (ownerWaiverProblem).
// Invariants: reads only (git only lists worktrees); a STATUS.md or repository that cannot be read is a problem, never a pass.
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { findSection, parseWorkItems } from '../../estimate/lib/items.mjs';
import { listWorktrees } from '../../git-tidy/lib/repo.mjs';
import { readStatusFile } from '../../status/status-file.mjs';

/** The text a landing row's evidence ends with when it landed under the waiver (land-lane writes it, the road gate reads it). */
export const UI_WAIVER_EVIDENCE = ' (ui-proof waived: owner decision)';
export const MAX_WAIVER_REASON_CHARS = 200; // the same rule as land-lane's --skip-review reason

const OWNER_DECISIONS = 'Owner decisions'; // the section status.mjs `decision` writes to
const ROAD_ROW = /^([a-z][a-z0-9-]{0,7})\.s[1-9]\d*\.[\w.:-]+$/; // `<road>.s<N>.<name>`, the road id as road-file.mjs ROAD_ID
const UNCONFIRMED = /UNCONFIRMED/i;
const NEGATION = /\b(no|not|never|revoked?|denied|declined|refused|withdrawn|cancell?ed)\b/i; // in the rest of a grant line
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const CASE_INSENSITIVE_FILES = process.platform === 'darwin' || process.platform === 'win32'; // default macOS and Windows volumes
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

/** The lines with what an HTML comment hides removed (a comment may span lines); lines in a code fence become ''. */
function visibleText(lines, visible) {
  let inComment = false;
  return lines.map((line, i) => {
    if (!visible[i]) return '';
    let shown = '';
    let rest = line;
    while (rest !== '') {
      const marker = rest.indexOf(inComment ? '-->' : '<!--');
      if (marker === -1) return inComment ? shown : shown + rest;
      if (!inComment) shown += rest.slice(0, marker);
      rest = rest.slice(marker + (inComment ? '-->' : '<!--').length);
      inComment = !inComment;
    }
    return shown;
  });
}

/**
 * The owner's waiver line for `road` in the STATUS.md text, or null when the waiver does not hold (see the rule in the header).
 * @param {string} statusText the whole STATUS.md
 * @param {string} road the road id
 * @returns {string|null} the granting line, trimmed (its visible part)
 */
export function ownerWaiverLine(statusText, road) {
  const lines = statusText.split(/\r?\n/);
  const section = findSection(lines, OWNER_DECISIONS);
  if (section.start === -1) return null;
  const phrase = `ui-proof waiver for road ${escapeRegExp(road)}(?![\\w-])`;
  const names = new RegExp(phrase, 'i');
  const grant = new RegExp(`^- (?:\\d{4}-\\d{2}-\\d{2} )?${phrase}(.*)$`);
  const shown = visibleText(lines, section.visible).slice(section.start + 1, section.end).map((line) => line.trim());
  const last = shown.filter((line) => names.test(line)).at(-1);
  const rest = last === undefined ? undefined : grant.exec(last)?.[1]; // undefined: no line names it, or the last one is no grant
  if (rest === undefined || NEGATION.test(rest) || UNCONFIRMED.test(last)) return null;
  return last;
}

/** True when `file` is `folder` or lies inside it, both with symlinks resolved (case folded where the volume ignores case). */
function isInside(folder, file) {
  const fold = (path) => (CASE_INSENSITIVE_FILES ? path.toLowerCase() : path);
  const path = relative(fold(realpathSync.native(folder)), fold(realpathSync.native(file)));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Why `statusFile` is no STATUS.md the waiver may be read from for a landing of `repo`, or null: it must lie outside all its worktrees. */
function placeProblem(statusFile, repo) {
  try {
    const folders = [repo, ...listWorktrees({ dir: repo }).filter((tree) => !tree.missing).map((tree) => tree.path)];
    const holder = folders.find((folder) => isInside(folder, statusFile));
    if (holder === undefined) return null;
    return `--owner-waive-ui: ${statusFile} lies inside ${holder}, a folder of the repository being landed; the owner's decision is read only from a STATUS.md outside it`;
  } catch (error) {
    return `--owner-waive-ui: cannot list the worktrees of ${repo} or resolve ${statusFile} (${error.message}), so the owner's decision cannot be checked`;
  }
}

/**
 * Why the waiver does not hold for a landing that closes `closeRow`, or null when it holds: the row is a road row `<road>.s<N>.<name>`,
 * the STATUS.md lies outside the repository being landed (real paths), holds that row in `## Work items` and the owner's line for the road.
 * @param {{ statusFile: string, closeRow: string, repo: string }} landing absolute STATUS.md path (read without following a link), the row
 *   the landing closes, and the folder of the repository being landed
 * @returns {string|null} the problem, naming what is missing
 */
export function ownerWaiverProblem({ statusFile, closeRow, repo }) {
  const road = roadOfRow(closeRow);
  if (road === null) return `--owner-waive-ui: ${JSON.stringify(closeRow)} is not a road lane row <road>.s<N>.<name> (its road names the owner's decision)`;
  let read;
  try {
    read = readStatusFile(statusFile);
  } catch (error) {
    return `--owner-waive-ui: ${statusFile} cannot be read (${error.message}), so the owner's decision cannot be checked`;
  }
  if (read.refused !== undefined) return `--owner-waive-ui: ${statusFile} ${read.refused}, so the owner's decision cannot be checked`;
  const place = placeProblem(statusFile, repo);
  if (place !== null) return place;
  const rowId = closeRow.toLowerCase();
  if (!parseWorkItems(read.text).items.some((item) => item.id.toLowerCase() === rowId)) {
    return `--owner-waive-ui: ${statusFile} does not hold the row ${closeRow}; the waiver is read only from the STATUS.md that holds the close row`;
  }
  if (ownerWaiverLine(read.text, road) !== null) return null;
  return `--owner-waive-ui: no owner decision for road ${road}: \`## ${OWNER_DECISIONS}\` in ${statusFile} needs a line with "ui-proof waiver for road ${road}"`
    + ' (the owner\'s own answer, recorded with status.mjs decision; a line with UNCONFIRMED, a negated or a later revoking line does not count)';
}
