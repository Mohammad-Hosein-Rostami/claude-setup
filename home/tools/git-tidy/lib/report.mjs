// Purpose: print the result of `check` and `prune` as text lines or as one JSON object.
// Exports: formatCheck, formatPrune.
// Invariants: items are `{ kind, subject, detail }`; a text line is `<kind> <subject> <detail>` and the last line is a
//   summary. JSON carries the same items, so a path with spaces stays exact there.
const line = ({ kind, subject, detail }) => `${kind} ${subject} ${detail}`;

/** `check` result as text (items, then `git-tidy: N findings, M hints (base B)`) or as `{ base, findings, hints }` JSON. */
export function formatCheck({ base, findings, hints }, json) {
  if (json) return JSON.stringify({ base, findings, hints }, null, 2);
  return [...findings, ...hints].map(line).concat(`git-tidy: ${findings.length} findings, ${hints.length} hints (base ${base})`).join('\n');
}
