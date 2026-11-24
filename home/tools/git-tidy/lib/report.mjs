// Purpose: print the result of `check`, `prune` and `land` as text lines or as one JSON object.
// Exports: formatCheck, formatPrune, pruneExitCode, formatLand, landExitCode.
// Invariants: items are `{ kind, subject, detail }`; a text line is `<kind> <subject> <detail>` and the last line is a
//   summary. JSON carries the same items, so a path with spaces stays exact there.
const line = ({ kind, subject, detail }) => `${kind} ${subject} ${detail}`;
// Findings that mean some local branch or tag still shows old, tangled or already merged history in `git log --graph --all`.
const ONE_LINE_BREAKERS = new Set(['merge-commit', 'tangled-ref', 'merged-branch', 'merged-tag', 'superseded-copy', 'agent-leftover', 'folded-branch']);
const baseLine = ({ base, baseSource }) => `base: ${base} (${baseSource})`;

// Info items (check.mjs) are neither findings nor hints: `lane folders: 3 free`, `not started: <branch> in <path> ...`.
const INFO_LABELS = Object.freeze({ 'lane-folders': 'lane folders', 'not-started-lane': 'not started' });
const infoLine = ({ kind, subject, detail }) => `${INFO_LABELS[kind] ?? kind}: ${subject}${detail ? ` ${detail}` : ''}`;

/**
 * `check` result as text (`base: <branch> (<how chosen>)`, findings, hints, info lines, then `git-tidy: N findings, M hints (base B)`)
 * or as `{ base, findings, hints }` JSON, plus `info` when there is any (info never counts as a finding or a hint).
 */
export function formatCheck({ base, baseSource, findings, hints, info = [] }, json) {
  if (json) return JSON.stringify({ base, findings, hints, ...(info.length > 0 ? { info } : {}) }, null, 2);
  const oneLine = findings.some((finding) => ONE_LINE_BREAKERS.has(finding.kind)) ? 'no' : 'yes';
  const summary = `git-tidy: ${findings.length} findings, ${hints.length} hints (base ${base}), all local refs on one line: ${oneLine}`;
  return [baseLine({ base, baseSource }), ...[...findings, ...hints].map(line), ...info.map(infoLine), summary].join('\n');
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

const LAND_EXIT = { rebased: 0, conflict: 3, 'base-moved': 5, 'ui-proof': 6, 'new-file-size': 7, 'upstream-moved': 8, 'tip-moved': 9 };

/** Exit code of `land`: 0 landed clean (or only rebased), 1 landed with findings left, 3 conflict, 5 base moved,
 * 6 no UI proof for the rebased tip, 7 a new file over the size limit that the brief does not name, 8 the upstream holds commits the base lacks, 9 the branch is not at the given `--tip`. */
export const landExitCode = ({ status, findings }) => (status === 'landed' ? (findings.length > 0 ? 1 : 0) : LAND_EXIT[status]);

/** The upstream lines of a landing: the WARN of a fetch that did not happen, and the published count (never amend, rebase or prune those). */
function upstreamText(upstream) {
  if (!upstream?.upstream) return [];
  const warn = upstream.warn ? [`WARN ${upstream.warn}; compared with the last fetched ${upstream.upstream}`] : [];
  return [...warn, `published ${upstream.published} base commit(s) are on ${upstream.upstream} (${upstream.unpublished} not pushed): fixes go on top, never amend or rebase them (C37)`];
}

/**
 * The refusal of a UI check plan that is not proved: a planned check (`uiDepth`) names its plan; a visual or pixel plan, which prints
 * today's pixel-qa check, keeps today's line word for word (F5).
 */
function uiProofText({ tip, why, uiDepth }) {
  const short = tip.slice(0, 8);
  if (typeof uiDepth !== 'string') return `ui-proof: the UI files changed and ${short} has no pixel-qa PASS: ${why} (run pixel-qa on the rebased tip, then land again)`;
  return `ui-proof: the ui check plan (${uiDepth}) of ${short} is not proved: ${why} (ui-proof plan --base <base> --tip ${short} --request <brief> shows what it needs; prove it on the rebased tip, then land again)`;
}

/** The lines of a proved check plan: `ui plan <depth>: proved`, then its `follow-up:` lines. */
const planText = (uiPlan) => (uiPlan ? [`ui plan ${uiPlan.depth}: proved`, ...uiPlan.followUps] : []);

/** `land` result as text (`tip` and `patches-changed` for a rebase; else what happened, what was removed, `check: clean` or the findings) or as JSON. */
export function formatLand(result, json) {
  if (json) return JSON.stringify(result, null, 2);
  const { status, tip, from, patchesChanged, removed, cleanupRefused, findings, files, why, upstream } = result;
  if (status === 'upstream-moved') return `upstream moved: ${why}: \`git pull --rebase\` first, then land again (the lane stays rebased)`;
  const upstreamLines = upstreamText(upstream);
  if (status === 'tip-moved') return `tip-moved: ${why}: the lane changed since the tip was read: land again with its new tip (nothing was touched)`;
  if (status === 'rebased') return `tip ${tip}\npatches-changed ${patchesChanged}`;
  if (status === 'conflict') return [`conflict: the rebase hit conflicts and was aborted, the lane is unchanged`, ...files.map((file) => `conflict ${file}`)].join('\n');
  if (status === 'ui-proof') return uiProofText(result);
  if (status === 'new-file-size') return [`new-file-size: the lane adds files over the size limit that its brief does not name: ${why}`, ...files.map((file) => `big ${file}`)].join('\n');
  if (status === 'base-moved') return `base-moved: ${why ?? 'the base moved during the landing'}: land again with --tip ${tip} (the lane stays rebased, nothing landed)`;
  const outcome = findings.length === 0 ? ['check: clean'] : findings.map(line);
  const refused = cleanupRefused === null ? [] : [`cleanup skipped: ${cleanupRefused}`];
  const detached = typeof result.detached?.folder === 'string' ? [`lane folder ${result.detached.folder} detached at ${tip} (kept for the next lane)`] : [];
  return [`landed ${tip}`, ...(from ? [`from ${from}`] : []), ...planText(result.uiPlan), ...upstreamLines, ...detached, ...removed.map((entry) => `removed ${entry}`), ...refused, ...outcome].join('\n');
}
