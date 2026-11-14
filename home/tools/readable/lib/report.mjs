// Purpose: turn findings into the text `readable check` prints: one line per finding, then a one-line summary.
// Exports: CHECK_ORDER, formatFinding(finding), formatReport(findings).
// Invariants: pure; findings are sorted by path, then line; the last line is `readable: ok` or
//   `readable: <n> findings (<check> <count>, ...)` listing only checks that found something.

export const CHECK_ORDER = ['no-readme', 'dumping-ground', 'deep-nesting', 'no-header', 'config-comment', 'allow-list'];

export const formatFinding = (f) => `${f.path}:${f.line} ${f.rule} ${f.check}: ${f.message} Fix: ${f.fix}`;

const compare = (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.check.localeCompare(b.check);

/** @returns {string} the full report text, without a trailing newline */
export function formatReport(findings) {
  if (findings.length === 0) return 'readable: ok';
  const counts = CHECK_ORDER.map((check) => [check, findings.filter((f) => f.check === check).length]).filter(([, n]) => n > 0);
  const lines = [...findings].sort(compare).map(formatFinding);
  return [...lines, `readable: ${findings.length} finding${findings.length === 1 ? '' : 's'} (${counts.map(([c, n]) => `${c} ${n}`).join(', ')})`].join('\n');
}
