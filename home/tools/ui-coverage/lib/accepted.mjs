// Purpose: the compare gate of `check`: a Figma compare failure may be accepted only with a written reason, which the report lists
//   so the owner sees every accepted difference when checking the results (owner, 2026-11-24: no owner approval during the work).
// Exports: acceptedChecks(matrix, merged, records), pixelAcceptances(matrix, record) (the entries `ui-check attribute` classes
//   pixels with).
// Invariants: pure; never throws. A cell is accepted when it fails ONLY through `part: "compare"` records (no hand-set fail, no
//   responsive fail) and every finding of those records is covered by an `accepted` entry of the same frame node and cell: an
//   `element` finding by the same element, a `pixel` finding by a `percent` not above `maxPercent` (a pixel finding without a number
//   is never covered). The entry needs a `reason` of MIN_REASON_CHARS+ characters (why the difference is accepted); a covering entry
//   without one is an `accepted-reason` problem and the cell keeps failing. An `owner` field of an older matrix is not read. An entry
//   that names a frame cell the matrix does not map is an `accepted-node` problem.
import { cellKey, cellLabel } from './cells.mjs';
import { MIN_REASON_CHARS, isReason, normalizeNode, problem } from './shape.mjs';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const NO_REASON = `no reason (write why the difference is accepted, ${MIN_REASON_CHARS}+ characters)`;

// The accepted-reason problem of an involved entry that has no reason, or null when it can accept.
function refusal(entry, cell) {
  if (isReason(entry.reason)) return null;
  return problem('accepted-reason', `accepted difference on ${cell} (frame ${entry.node}) has ${NO_REASON}; add the reason or match Figma`, { cell, cause: `accepted difference has ${NO_REASON}` });
}

function covers(entry, finding) {
  return entry.findings.some((own) => (finding.check === 'element' ? own.check === 'element' && own.element === finding.element : finding.check === 'pixel' && own.check === 'pixel' && typeof finding.percent === 'number' && finding.percent <= own.maxPercent));
}

// Findings of the cells whose only failures are compare records, by cell key; a cell with any other failure is left out.
function compareOnlyFindings(matrix, merged, records) {
  const handSet = new Set((matrix.cells ?? []).filter((cell) => cell.status === 'fail').map(cellKey));
  const failing = new Set(merged.cells.filter((cell) => cell.status === 'fail').map(cellKey));
  const byKey = new Map();
  for (const record of records.filter((r) => isObject(r) && r.status === 'fail' && failing.has(cellKey(r)))) {
    const group = byKey.get(cellKey(record)) ?? { compareOnly: true, findings: [] };
    group.compareOnly &&= record.part === 'compare';
    group.findings.push(...(Array.isArray(record.findings) ? record.findings.filter(isObject) : []));
    byKey.set(cellKey(record), group);
  }
  return [...byKey].filter(([key, group]) => group.compareOnly && group.findings.length > 0 && !handSet.has(key));
}

// The key of the cell an entry accepts, or null when the matrix frames do not map that cell for that node.
function entryKey(matrix, entry) {
  const frame = (matrix.frames ?? []).find((candidate) => normalizeNode(candidate.node) === normalizeNode(entry.node));
  const mapped = (frame?.cells ?? []).some((cell) => cell.surface === entry.surface && cell.state === entry.state && cell.locale === entry.locale);
  return mapped ? cellKey({ surface: entry.surface, state: entry.state, locale: entry.locale, width: frame.width }) : null;
}

/**
 * Decides which failing compare cells are accepted by an entry with a reason.
 * @param {object} matrix a structurally sound matrix
 * @param {{cells: object[]}} merged the result of mergeResults
 * @param {unknown[]} records ui-check result records
 * @returns {{problems: object[], accepted: {key: string, cell: string, node: string, reason: string}[]}} `accepted` lists the cells
 *   whose `fail` problem is dropped, each with the reasons of its covering entries (joined by "; ")
 */
export function acceptedChecks(matrix, merged, records) {
  const prepared = (Array.isArray(matrix.accepted) ? matrix.accepted : []).map((entry) => ({ entry, key: entryKey(matrix, entry) }));
  const problems = prepared
    .filter((item) => item.key === null)
    .map(({ entry }) => problem('accepted-node', `accepted entry for frame ${entry.node} names ${entry.surface} ${entry.state} ${entry.locale}, which that frame does not map in matrix frames`));
  const accepted = [];
  for (const [key, { findings }] of compareOnlyFindings(matrix, merged, records)) {
    const cell = cellLabel(merged.cells.find((candidate) => cellKey(candidate) === key));
    const involved = prepared.filter((item) => item.key === key && findings.some((finding) => covers(item.entry, finding)));
    const refused = involved.map((item) => refusal(item.entry, cell));
    problems.push(...refused.filter((found) => found !== null));
    const reasoned = involved.filter((item, index) => refused[index] === null).map((item) => item.entry);
    if (findings.every((finding) => reasoned.some((entry) => covers(entry, finding)))) {
      accepted.push({ key, cell, node: reasoned[0].node, reason: [...new Set(reasoned.map((entry) => entry.reason.trim()))].join('; ') });
    }
  }
  return { problems, accepted };
}

/**
 * The accepted entries that may class pixels of one failing compare record as accepted (`ui-check attribute`): the same frame node and
 *   cell, a reason, and a pixel rule whose `maxPercent` is not below the record's pixel `percent`.
 * @param {object} matrix a structurally sound matrix
 * @param {object} record a ui-check compare record (surface, state, locale, width, findings)
 * @returns {{reason: string, nodes: string[]|null}[]} `nodes` = the Figma node ids the rule names (its optional `nodes` list), null
 *   when the rule covers every pixel of the record; empty when nothing applies
 */
export function pixelAcceptances(matrix, record) {
  const pixel = (Array.isArray(record.findings) ? record.findings : []).find((finding) => isObject(finding) && finding.check === 'pixel');
  if (pixel === undefined || typeof pixel.percent !== 'number') return [];
  const entries = (Array.isArray(matrix.accepted) ? matrix.accepted : []).filter((entry) => isObject(entry) && entryKey(matrix, entry) === cellKey(record));
  return entries
    .filter((entry) => isReason(entry.reason))
    .flatMap((entry) => (Array.isArray(entry.findings) ? entry.findings : [])
      .filter((own) => isObject(own) && own.check === 'pixel' && pixel.percent <= own.maxPercent)
      .map((own) => ({ reason: entry.reason.trim(), nodes: Array.isArray(own.nodes) ? own.nodes.map(String) : null })));
}
