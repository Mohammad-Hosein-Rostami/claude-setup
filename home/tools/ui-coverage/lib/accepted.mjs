// Purpose: the compare gate of `check`: a Figma compare failure may be accepted only with a recorded owner decision and a reason.
// Exports: acceptedChecks(matrix, merged, records, options), pixelAcceptances(matrix, record, options) (the entries `ui-check attribute`
//   classes pixels with).
// Invariants: pure apart from the injected `readText`; never throws. A cell is accepted when it fails ONLY through
//   `part: "compare"` records (no hand-set fail, no responsive fail) and every finding of those records is covered by an
//   `accepted` entry of the same frame node and cell: an `element` finding by the same element, a `pixel` finding by a `percent`
//   not above `maxPercent` (a pixel finding without a number is never covered). The entry's `owner` must name a decision the
//   owner made: `{status: "STATUS.md", line}` (that exact line of that notes file sits under `## Standing rules` or
//   `## Owner decisions` and names the node). The old `{ask: "<queue>#q2", answer}` form fails closed: the ask queue it read is
//   gone. Paths resolve from the matrix directory. The entry also needs a `reason` of MIN_REASON_CHARS+ characters (why the
//   owner accepted it). A covering entry with a bad owner or no reason is an `owner-ref` problem and the cell keeps failing. An entry that names a frame cell the matrix does not map is an `accepted-node` problem.
import { resolve } from 'node:path';
import { cellKey, cellLabel } from './cells.mjs';
import { MIN_REASON_CHARS, isReason, isText, namesNode, normalizeNode, problem } from './shape.mjs';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const OWNER_SECTIONS = new Set(['## Standing rules', '## Owner decisions']);
const SECTION_START = '## ';
const ASK_FORM_GONE = 'owner.ask is no longer read (the ask queue was removed); write the decision as {status, line}';

// The lines of the owner sections (`## Standing rules`, `## Owner decisions`) of a notes file; CRLF files are read like LF ones.
function ownerSectionLines(text) {
  let inside = false;
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(SECTION_START)) inside = OWNER_SECTIONS.has(line.trimEnd());
    else if (inside) found.push(line);
  }
  return found;
}

// Why a `status` owner ref is not an owner decision, or null when it is.
function statusWhy(owner, node, { baseDir, readText }) {
  const text = isText(owner.status) ? readText(resolve(baseDir, owner.status)) : null;
  if (text === null) return `${owner.status} cannot be read`;
  if (!isText(owner.line) || !ownerSectionLines(text).includes(owner.line)) return 'line not under those headings (## Standing rules, ## Owner decisions)';
  return namesNode(owner.line, node) ? null : `line does not name ${node}`;
}

// Why the owner field of an accepted entry is not an owner decision, or null when it is.
function ownerWhy(entry, files) {
  if (!isObject(entry.owner)) return 'no owner field';
  if (entry.owner.ask !== undefined) return ASK_FORM_GONE;
  if (entry.owner.status !== undefined) return statusWhy(entry.owner, entry.node, files);
  return 'no owner field';
}

const NO_REASON = `no reason (write why the owner accepted it, ${MIN_REASON_CHARS}+ characters)`;

// The owner-ref problem of an involved entry that cannot accept anything (no owner decision, or no reason), or null when it can.
function refusal(entry, why, cell) {
  if (why !== null) return problem('owner-ref', `accepted difference on ${cell} (frame ${entry.node}) has no owner decision: ${why}; ask the owner or match Figma`, { cell, cause: `accepted difference has no owner decision: ${why}` });
  if (!isReason(entry.reason)) return problem('owner-ref', `accepted difference on ${cell} (frame ${entry.node}) has ${NO_REASON}`, { cell, cause: `accepted difference has ${NO_REASON}` });
  return null;
}

const refText = ({ owner }) => `${owner.status} line "${owner.line}"`;

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
 * Decides which failing compare cells the owner accepted.
 * @param {object} matrix a structurally sound matrix
 * @param {{cells: object[]}} merged the result of mergeResults
 * @param {unknown[]} records ui-check result records
 * @param {{baseDir: string, readText: (path: string) => string|null}} options where relative paths resolve from and how to read
 *   a file (null = no such file)
 * @returns {{problems: object[], accepted: {key: string, cell: string, node: string, ref: string}[]}} `accepted` lists the cells whose `fail` problem is dropped
 */
export function acceptedChecks(matrix, merged, records, { baseDir, readText }) {
  const files = { baseDir, readText: readText ?? (() => null) };
  const prepared = (Array.isArray(matrix.accepted) ? matrix.accepted : []).map((entry) => ({ entry, key: entryKey(matrix, entry), why: ownerWhy(entry, files) }));
  const problems = prepared
    .filter((item) => item.key === null)
    .map(({ entry }) => problem('accepted-node', `accepted entry for frame ${entry.node} names ${entry.surface} ${entry.state} ${entry.locale}, which that frame does not map in matrix frames`));
  const accepted = [];
  for (const [key, { findings }] of compareOnlyFindings(matrix, merged, records)) {
    const cell = cellLabel(merged.cells.find((candidate) => cellKey(candidate) === key));
    const involved = prepared.filter((item) => item.key === key && findings.some((finding) => covers(item.entry, finding)));
    const refused = involved.map((item) => refusal(item.entry, item.why, cell));
    problems.push(...refused.filter((found) => found !== null));
    const owned = involved.filter((item, index) => refused[index] === null).map((item) => item.entry);
    if (findings.every((finding) => owned.some((entry) => covers(entry, finding)))) {
      accepted.push({ key, cell, node: owned[0].node, ref: [...new Set(owned.map(refText))].join('; ') });
    }
  }
  return { problems, accepted };
}

/**
 * The accepted entries that may class pixels of one failing compare record as accepted (`ui-check attribute`): the same frame node and
 *   cell, an owner decision, a reason, and a pixel rule whose `maxPercent` is not below the record's pixel `percent`.
 * @param {object} matrix a structurally sound matrix
 * @param {object} record a ui-check compare record (surface, state, locale, width, findings)
 * @param {{baseDir: string, readText: (path: string) => string|null}} options as acceptedChecks
 * @returns {{reason: string, nodes: string[]|null, ref: string}[]} `nodes` = the Figma node ids the rule names (its optional `nodes`
 *   list), null when the rule covers every pixel of the record; empty when nothing applies
 */
export function pixelAcceptances(matrix, record, { baseDir, readText }) {
  const files = { baseDir, readText: readText ?? (() => null) };
  const pixel = (Array.isArray(record.findings) ? record.findings : []).find((finding) => isObject(finding) && finding.check === 'pixel');
  if (pixel === undefined || typeof pixel.percent !== 'number') return [];
  const entries = (Array.isArray(matrix.accepted) ? matrix.accepted : []).filter((entry) => isObject(entry) && entryKey(matrix, entry) === cellKey(record));
  return entries
    .filter((entry) => ownerWhy(entry, files) === null && isReason(entry.reason))
    .flatMap((entry) => (Array.isArray(entry.findings) ? entry.findings : [])
      .filter((own) => isObject(own) && own.check === 'pixel' && pixel.percent <= own.maxPercent)
      .map((own) => ({ reason: entry.reason.trim(), nodes: Array.isArray(own.nodes) ? own.nodes.map(String) : null, ref: refText(entry) })));
}
