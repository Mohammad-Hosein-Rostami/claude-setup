// Purpose: the session-start text of git-tidy-gate.mjs (spec-p3 `r9-git-line`): the lanes of the session's repo not yet landed.
// Exports: unlandedText(top, verdict).
// Invariants: pure (no git, no files); a verdict is the slim check verdict of lib/tidy-check-child.mjs (or null: no text); names in it are
//   already plain and capped there (they are data).

/**
 * The lanes not yet landed in `top`, a header and one line each; '' when none. A lane that is both an unlanded lane and an open branch
 * (two hints of one subject) is named once, by its first hint: the unlanded one, which says what to do.
 */
export function unlandedText(top, verdict) {
  const named = new Set();
  const lanes = (verdict?.hints ?? []).filter(({ subject }) => !named.has(subject) && named.add(subject));
  if (lanes.length === 0) return '';
  return [`git: lanes not yet landed in ${top} (land or prune them, one line of history):`, ...lanes.map(({ subject, detail }) => `- ${subject}: ${detail}`)].join('\n');
}
