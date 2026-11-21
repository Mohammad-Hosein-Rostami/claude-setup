// Purpose: the two in-work texts of git-tidy-gate.mjs (spec-p3 `r9-git-line`): at SessionStart the lanes of the session's repo not yet
//   landed, and after a `git worktree add`, `merge` or `branch` the "run git-tidy prune" note above PRUNE_NOTE_ABOVE lanes or prunable items.
// Exports: wantsPruneNote(input), unlandedText(top, verdict), pruneNoteText(top, verdict), PRUNE_NOTE_ABOVE.
// Invariants: pure (no git, no files); a verdict is the slim check verdict of lib/tidy-check-child.mjs (or null: no text); names in it are
//   already plain and capped there (they are data).
import { PRUNE_KINDS } from './tidy-check-child.mjs';

export const PRUNE_NOTE_ABOVE = 5; // the step cap (research2/human.md 9): more unlanded lanes or prunable items than this asks for a prune
const GIT_LINE_COMMAND = /\bgit\b[^|;&\n]*\b(?:worktree\s+add|merge|branch)\b/; // the commands that add lanes or leftovers

/** True when the PostToolUse(Bash) input ran a git command that adds lanes or leftovers. */
export const wantsPruneNote = (input) => GIT_LINE_COMMAND.test(String(input?.tool_input?.command ?? ''));

/** The lanes not yet landed in `top`, a header and one line each; '' when none. */
export function unlandedText(top, verdict) {
  const lanes = verdict?.hints ?? [];
  if (lanes.length === 0) return '';
  return [`git: lanes not yet landed in ${top} (land or prune them, one line of history):`, ...lanes.map(({ subject, detail }) => `- ${subject}: ${detail}`)].join('\n');
}

/** The prune note when `top` holds more than PRUNE_NOTE_ABOVE unlanded lanes plus prunable items; '' otherwise. */
export function pruneNoteText(top, verdict) {
  const count = (verdict?.hints ?? []).length + (verdict?.findings ?? []).filter(({ kind }) => PRUNE_KINDS.has(kind)).length;
  if (count <= PRUNE_NOTE_ABOVE) return '';
  return `git: ${count} unlanded lane branches or prunable items in ${top}: land what is done, then run git-tidy prune (node ~/.claude/tools/git-tidy/git-tidy.mjs prune --apply) so history stays one line (C37).`;
}
