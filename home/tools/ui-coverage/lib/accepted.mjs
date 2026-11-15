// Purpose: the compare gate of `check`: a Figma compare failure may be accepted only with a recorded owner decision.
// Exports: acceptedChecks(matrix, merged, records, options).
// Invariants: pure apart from the injected `readText`; never throws. A cell is accepted when it fails ONLY through
//   `part: "compare"` records (no hand-set fail, no responsive fail) and every finding of those records is covered by an
//   `accepted` entry of the same frame node and cell: an `element` finding by the same element, a `pixel` finding by a `percent`
//   not above `maxPercent` (a pixel finding without a number is never covered). The entry's `owner` must name a decision the
//   owner made: `{ask: "<queue>#q2", answer}` (the last answer to q2 equals `answer` exactly and was not taken by timeout) or
//   `{status: "STATUS.md", line}` (that exact line sits under `## Standing rules` or `## Owner decisions` and names the node).
//   Only an answer record with no `by` field counts as the owner's (anything marked, `timeout` or otherwise, fails closed);
//   the question must name the node as a whole token; the queue file must lie directly in the ask queue folder (real path,
//   no link out of it). Paths resolve from the matrix directory. A covering entry with a bad owner is an `owner-ref` problem and the cell keeps
//   failing. An entry that names a frame cell the matrix does not map is an `accepted-node` problem.
import { dirname, resolve } from 'node:path';
import { BY_TIMEOUT, ID_PATTERN, lastAnswer, parse } from '../../ask/lib/queue.mjs';
import { cellKey, cellLabel } from './cells.mjs';
import { isText, namesNode, normalizeNode, problem } from './shape.mjs';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const OWNER_SECTIONS = new Set(['## Standing rules', '## Owner decisions']);
const SECTION_START = '## ';
const REF_HASH = '#';

const MAX_MARK_CHARS = 40;
const MISSING = 'queue missing (copy the decision into STATUS.md Standing rules)';
const OUTSIDE = 'queue file is outside the ask queue folder (copy the decision into STATUS.md Standing rules)';

// Why an answer record is not the owner's, or null: only a record without a `by` mark was written by an owner answer.
function markWhy(id, record) {
  if (record === null) return `${id} unanswered`;
  if (record.by === undefined) return null;
  if (record.by === BY_TIMEOUT) return `${id} was taken by timeout, not answered by the owner`;
  return `${id} was marked by ${JSON.stringify(record.by).slice(0, MAX_MARK_CHARS)}, not answered by the owner`;
}

// Why an `ask` owner ref is not an owner decision, or null when it is.
function askWhy(owner, node, { baseDir, readText, queueDir, realPath }) {
  const at = isText(owner.ask) ? owner.ask.lastIndexOf(REF_HASH) : -1;
  const id = at < 0 ? '' : owner.ask.slice(at + 1);
  if (!ID_PATTERN.test(id)) return 'owner.ask must look like <queue path>#q2';
  const real = realPath(resolve(baseDir, owner.ask.slice(0, at)));
  if (real === null) return MISSING;
  if (queueDir === null || queueDir === undefined || dirname(real) !== queueDir) return OUTSIDE;
  const text = readText(real);
  if (text === null) return MISSING;
  const { records } = parse(text);
  const record = lastAnswer(records, id);
  const why = markWhy(id, record);
  if (why !== null) return why;
  if (record.answer !== owner.answer) return 'answer differs';
  const question = records.find((r) => r.type === 'q' && r.id === id);
  return namesNode(question.question, node) ? null : `${id} does not name frame ${node}`;
}

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
  if (entry.owner.ask !== undefined) return askWhy(entry.owner, entry.node, files);
  if (entry.owner.status !== undefined) return statusWhy(entry.owner, entry.node, files);
  return 'no owner field';
}

const refText = ({ owner }) => (owner.ask === undefined ? `${owner.status} line "${owner.line}"` : `ask ${owner.ask}`);

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
 * @param {{baseDir: string, readText: (path: string) => string|null, queueDir?: string|null, realPath?: (path: string) => string|null}} options where relative
 *   paths resolve from, how to read a file (null = no such file), the real path of the ask queue folder (none: every queue ref is outside it) and how to resolve a real path (null = no such file)
 * @returns {{problems: object[], accepted: {key: string, cell: string, node: string, ref: string}[]}} `accepted` lists the cells whose `fail` problem is dropped
 */
export function acceptedChecks(matrix, merged, records, { baseDir, readText, queueDir, realPath }) {
  const files = { baseDir, readText: readText ?? (() => null), queueDir, realPath: realPath ?? (() => null) };
  const prepared = (Array.isArray(matrix.accepted) ? matrix.accepted : []).map((entry) => ({ entry, key: entryKey(matrix, entry), why: ownerWhy(entry, files) }));
  const problems = prepared
    .filter((item) => item.key === null)
    .map(({ entry }) => problem('accepted-node', `accepted entry for frame ${entry.node} names ${entry.surface} ${entry.state} ${entry.locale}, which that frame does not map in matrix frames`));
  const accepted = [];
  for (const [key, { findings }] of compareOnlyFindings(matrix, merged, records)) {
    const cell = cellLabel(merged.cells.find((candidate) => cellKey(candidate) === key));
    const involved = prepared.filter((item) => item.key === key && findings.some((finding) => covers(item.entry, finding)));
    for (const { entry, why } of involved.filter((item) => item.why !== null)) {
      problems.push(problem('owner-ref', `accepted difference on ${cell} (frame ${entry.node}) has no owner decision: ${why}; ask the owner or match Figma`, { cell, cause: `accepted difference has no owner decision: ${why}` }));
    }
    const owned = involved.filter((item) => item.why === null).map((item) => item.entry);
    if (findings.every((finding) => owned.some((entry) => covers(entry, finding)))) {
      accepted.push({ key, cell, node: owned[0].node, ref: [...new Set(owned.map(refText))].join('; ') });
    }
  }
  return { problems, accepted };
}
