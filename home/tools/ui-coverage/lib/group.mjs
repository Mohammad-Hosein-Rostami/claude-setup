// Purpose: group the problems of a check by kind and root cause, so 268 failing cells with 8 causes print as 8 groups.
// Exports: groupProblems(problems), failCause(cell), EXAMPLES_PER_GROUP.
// Invariants: pure. A group is the problems with the same `code` and the same `cause` (a problem without `cause` is its
//   own cause: its message). Groups keep the order of their first problem; a group's problems keep their own order.
//   The fail cause is the cell's failing findings (check + element + detail), else its reason, else its evidence.

export const EXAMPLES_PER_GROUP = 3;
const MAX_CAUSE_CHARS = 240;

const clip = (text) => (text.length > MAX_CAUSE_CHARS ? `${text.slice(0, MAX_CAUSE_CHARS)}...` : text);
const findingText = (finding) => `${finding.check ?? 'finding'} ${finding.element ?? ''}: ${finding.detail ?? ''}`.replace(/\s+/g, ' ').trim();

/**
 * The root cause of a failing cell: what the tool found, or what the person who hand-set it wrote.
 * @param {{findings?: object[], reason?: string, evidence?: string}} cell a merged cell with status fail
 * @returns {string} the same text for every cell that fails for the same reason
 */
export function failCause(cell) {
  const findings = Array.isArray(cell.findings) ? [...new Set(cell.findings.map(findingText))].sort() : [];
  if (findings.length > 0) return clip(findings.join(' | '));
  const reason = String(cell.reason ?? '').trim();
  return clip(reason === '' ? `failed with no recorded finding (evidence ${cell.evidence ?? 'none'})` : reason);
}

/**
 * Groups problems by code and cause.
 * @param {{code: string, message: string, cause?: string}[]} problems
 * @returns {{code: string, cause: string, problems: object[]}[]}
 */
export function groupProblems(problems) {
  const groups = new Map();
  for (const item of problems) {
    const cause = item.cause ?? item.message;
    const key = JSON.stringify([item.code, cause]);
    const group = groups.get(key) ?? { code: item.code, cause, problems: [] };
    group.problems.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}
