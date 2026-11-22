// Purpose: read the lines a review lens writes (plan.md C4) and the prior file the verdict tool writes: findings with their fields, the
//   P/F checklist, the mutants block, the `prior: <n> fixed, <m> open` line and the final line. It only reads: what the lines mean is decided in verdict.mjs.
// Exports: parseReport(text), parsePriorFile(text), FIELD_ORDER, ORIGINS.
// Invariants: pure, never throws for bad input (a problem string instead). A finding line is `- [severity] <ID> <file:line>` and then fields split
//   on ` | ` only after the location. The fields come in FIELD_ORDER, each at most once, and no value holds ` | `: a `| origin: prior` written inside
//   `problem:` text is a field out of order, so the line is malformed and never counts as an origin (F2). The number of blocking and should-fix
//   findings of a text is `countFindings` of prior.mjs (one parser for counts, P5/P12): `counted` is its number, `findings` holds the lines this
//   file could read, and the caller compares them. Quoted lines (`>`) and fenced blocks, except the mutants block, are not read.
import { countFindings } from './prior.mjs';

export const FIELD_ORDER = ['class', 'problem', 'fix', 'parts', 'siblings', 'proof', 'origin', 'exploitable'];
export const ORIGINS = new Set(['prior', 'fix-line', 'sibling', 'security', 'lane-blocking']);

const FINDING_HEAD = /^- \[(blocking|should-fix|optional)\] ([A-Za-z][\w.-]{0,31}) (\S+)(?: \| (.*))?$/;
const FIELD = new RegExp(`^(${FIELD_ORDER.join('|')}):(?: (.*))?$`);
const CHECKLIST_LINE = /^- ([PF]\d{1,3}) (met|not met)\b(.*)$/;
const CHECKLIST_MET_REST = /^ (\S+)$/;
const CHECKLIST_NOT_MET_REST = /^ -> ([A-Za-z][\w.-]{0,31})$/;
const MUTANT_LINE = /^([A-Za-z0-9][\w.-]{0,31}) (\S+) (.+) (killed|survived)$/;
const FENCE = /^\s*(```|~~~)/;
const MUTANTS_OPEN = /^```mutants\s*$/;
const PRIOR_LINE = /^prior:/;
const SEGMENT_KEY = /^(plan|own|stress|race|mutants|head|read): ?(.*)$/;
const HEAD_FLAG = /^.+ at HEAD: (yes|no)$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const COUNT_PAIR = /^(\d+)\/(\d+)$/;
const WRONG_BASE = /^wrong base\b/;
const PRIOR_HEADER = /^# prior findings: lane (\S+), round (\d+), tip ([0-9a-f]{40})$/;
const PRIOR_ROUND = /^round: (\d+)$/;

/** Splits the text after a finding's location into its fields; `problem` says why the line is malformed, or is null. */
function readFields(rest) {
  const fields = {};
  if (rest === undefined) return { fields, problem: null };
  let lastAt = -1;
  for (const segment of rest.split(' | ')) {
    const match = FIELD.exec(segment);
    if (match === null) return { fields, problem: 'a part after the location is no known field' };
    const at = FIELD_ORDER.indexOf(match[1]);
    if (at <= lastAt) return { fields, problem: `field ${match[1]} is repeated or out of order` };
    lastAt = at;
    fields[match[1]] = (match[2] ?? '').trim();
  }
  return { fields, problem: null };
}

/** One finding line, or null when the line is none. `problem` is set for a line whose fields cannot be trusted. */
function readFinding(line) {
  const head = FINDING_HEAD.exec(line);
  if (head === null) return null;
  const { fields, problem } = readFields(head[4]);
  return { severity: head[1], id: head[2], location: head[3], fields, problem, raw: line };
}

/** The checklist entry of a line (`status`: met, not-met, or bad when its evidence or finding id is missing), or null for any other line. */
function readChecklist(line) {
  const match = CHECKLIST_LINE.exec(line);
  if (match === null) return null;
  const [, id, word, rest] = match;
  if (word === 'met') return { id, status: CHECKLIST_MET_REST.test(rest) ? 'met' : 'bad', findingId: null };
  const named = CHECKLIST_NOT_MET_REST.exec(rest);
  return { id, status: named === null ? 'bad' : 'not-met', findingId: named === null ? null : named[1] };
}

/** Reads the final line: `{kind, head, read, problem}`; `problem` names what is wrong, or is null. */
function readFinal(line) {
  const kind = line.startsWith('verified:') ? 'verified' : line.startsWith('exploitable:') ? 'exploitable' : null;
  if (kind === null) return null;
  const [first, ...segments] = line.slice(kind.length + 1).trim().split('; ');
  const final = { kind, head: null, read: null, problem: null };
  if (kind === 'verified' ? !HEAD_FLAG.test(first) : !/^(yes|no|unknown)$/.test(first)) final.problem = `the first part of the ${kind}: line is not in the contract format`;
  const keyed = segments.map((segment) => SEGMENT_KEY.exec(segment)).filter((match) => match !== null);
  const only = (key) => keyed.filter((match) => match[1] === key);
  if (only('head').length !== 1 || !FULL_SHA.test(only('head')[0][2])) final.problem ??= 'the final line needs exactly one `head: <40-hex>`';
  else final.head = only('head')[0][2].toLowerCase();
  const read = only('read').length === 1 ? COUNT_PAIR.exec(only('read')[0][2]) : null;
  if (read === null) final.problem ??= 'the final line needs exactly one `read: <a>/<b>`';
  else final.read = [Number(read[1]), Number(read[2])];
  return final;
}

/**
 * Reads one lens report.
 * @param {string} text the report as the lens wrote it
 * @returns {{findings: object[], counted: number, checklist: object[], mutants: {id: string, raw: string}[], badMutantLines: number,
 *   priorLines: string[], restText: string, wrongBase: boolean, final: object|null, endsInFence: boolean}} `findings`: the well-formed
 *   lines of every severity (`{severity, id, location, fields, problem, raw}`); `counted`: blocking plus should-fix findings by countFindings;
 *   `priorLines`: every line that starts `prior:`; `restText`: the lines that are no finding, no fenced and no quoted line (the place the
 *   phrase "needs the full range" is looked for); `final`: the last non-empty line read as a final line, or null
 */
export function parseReport(text) {
  const lines = text.split('\n').map((line) => line.trimEnd());
  const report = { findings: [], counted: countFindings(text).findings, checklist: [], mutants: [], badMutantLines: 0, priorLines: [], restText: '', wrongBase: WRONG_BASE.test(text.trimStart()), final: null, endsInFence: false };
  let inFence = false;
  let inMutants = false;
  const rest = [];
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (!inFence && MUTANTS_OPEN.test(line)) inMutants = true;
      else if (inFence) inMutants = false;
      inFence = !inFence;
      continue;
    }
    if (inMutants) {
      const mutant = MUTANT_LINE.exec(line);
      if (mutant !== null) report.mutants.push({ id: mutant[1], raw: line });
      else if (line.trim() !== '') report.badMutantLines += 1;
    } else if (!inFence && !line.startsWith('>')) {
      const finding = readFinding(line);
      const entry = finding === null ? readChecklist(line) : null;
      if (finding !== null) report.findings.push(finding);
      else if (entry !== null) report.checklist.push(entry);
      else if (!line.startsWith('- [')) rest.push(line);
      if (PRIOR_LINE.test(line)) report.priorLines.push(line);
    }
  }
  report.restText = rest.join('\n');
  report.endsInFence = inFence;
  const lastLine = [...lines].reverse().find((line) => line.trim() !== '');
  report.final = lastLine === undefined ? null : readFinal(lastLine);
  return report;
}

/**
 * Reads a prior file the verdict tool wrote.
 * @param {string} text the file
 * @returns {{lane: string, round: number, tip: string, report: object}|null} null when the header or the `round:` line is missing or disagrees;
 *   `report` is parseReport of the same text (its findings and mutants block)
 */
export function parsePriorFile(text) {
  const lines = text.split('\n');
  const header = PRIOR_HEADER.exec(lines[0] ?? '');
  const round = PRIOR_ROUND.exec(lines[1] ?? '');
  if (header === null || round === null || header[2] !== round[1]) return null;
  return { lane: header[1], round: Number(round[1]), tip: header[3], report: parseReport(text) };
}
