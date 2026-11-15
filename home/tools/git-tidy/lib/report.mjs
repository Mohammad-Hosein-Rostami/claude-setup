// Purpose: print the result of `check` and `prune` as text lines or as one JSON object.
// Exports: formatCheck, formatPrune, pruneExitCode.
// Invariants: items are `{ kind, subject, detail }`; a text line is `<kind> <subject> <detail>` and the last line is a
//   summary. JSON carries the same items, so a path with spaces stays exact there.
const line = ({ kind, subject, detail }) => `${kind} ${subject} ${detail}`;
// Findings that mean some local branch or tag still shows old, tangled or already merged history in `git log --graph --all`.
const ONE_LINE_BREAKERS = new Set(['merge-commit', 'tangled-ref', 'merged-branch', 'merged-tag']);
const baseLine = ({ base, baseSource }) => `base: ${base} (${baseSource})`;

/** `check` result as text (`base: <branch> (<how chosen>)`, items, then `git-tidy: N findings, M hints (base B)`) or as `{ base, findings, hints }` JSON. */
export function formatCheck({ base, baseSource, findings, hints }, json) {
  if (json) return JSON.stringify({ base, findings, hints }, null, 2);
  const oneLine = findings.some((finding) => ONE_LINE_BREAKERS.has(finding.kind)) ? 'no' : 'yes';
  const summary = `git-tidy: ${findings.length} findings, ${hints.length} hints (base ${base}), all local refs on one line: ${oneLine}`;
  return [baseLine({ base, baseSource }), ...[...findings, ...hints].map(line), summary].join('\n');
}

const NOT_REMOVED = new Set(['kept', 'failed']);

/** `base:` line, one line per prune item (`deleted <name> (was <hash>)` for a deleted branch) and a summary, or `{ base, apply, items }` JSON. */
export function formatPrune({ base, baseSource, apply, items }, json) {
  if (json) return JSON.stringify({ base, apply, items }, null, 2);
  const count = (...actions) => items.filter((entry) => actions.includes(entry.action)).length;
  const body = items.map((entry) => {
    if (entry.action === 'note') return `tags (${entry.detail}: delete by hand after verifying your bundle backup): ${entry.subject}`;
    return entry.action === 'deleted' ? `deleted ${entry.subject} (${entry.detail})` : `${entry.action} ${entry.kind} ${entry.subject} ${entry.detail}`;
  });
  const summary = apply
    ? `git-tidy prune: ${count('removed', 'deleted')} removed, ${count('kept')} kept, ${count('failed')} failed (base ${base})`
    : `git-tidy prune: ${count('remove')} to remove, ${count('keep')} kept (base ${base}), dry run: add --apply to remove`;
  return [baseLine({ base, baseSource }), ...body, summary].join('\n');
}

/** 1 when `--apply` left something it planned to remove (kept or failed; a detached worktree is only listed), else 0. */
export const pruneExitCode = (items) => (items.some((entry) => NOT_REMOVED.has(entry.action) && entry.kind !== 'detached-worktree') ? 1 : 0);
