// Purpose: print the result of a scan as text lines or as one JSON object.
// Exports: formatText, formatJson.
// Invariants: findings first, then hints, each sorted as the scan sorted them; `unreadable?` and `tsconfig-path?` carry a
//   reason as the value and no `-> missing`, because nothing was found missing.
const NOTE_KINDS = new Set(['unreadable?', 'tsconfig-path?']); // the value is a sentence, nothing is "missing"
const lineOf = (item) => (NOTE_KINDS.has(item.kind) ? `${item.file}:${item.line} ${item.kind} ${item.value}` : `${item.file}:${item.line} ${item.kind} ${item.value} -> missing`);

/** One line per finding and hint, then `refs: N findings, M hints in K files scanned`. */
export function formatText({ findings, hints, scanned }) {
  const lines = [...findings, ...hints].map(lineOf);
  lines.push(`refs: ${findings.length} findings, ${hints.length} hints in ${scanned} files scanned`);
  return lines.join('\n');
}

/** `{ findings, hints, scanned }` as JSON, each item `{file, line, kind, value}`. */
export const formatJson = ({ findings, hints, scanned }) => JSON.stringify({ findings, hints, scanned }, null, 2);
