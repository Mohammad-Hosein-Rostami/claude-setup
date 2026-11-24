// Purpose: the one-time cleanup of the state that removed parts of this setup left in ~/.claude (lex-dev-tess plan, 2026-11-24):
//   the recall index, checkpoints and usage log, the ask queue, the estimate tables and caches, the done-check ledger and runs,
//   the commit-gate and call-window logs, the session-mode files, the last-seen costs and the ui-proof-gate blocks.
// Exports: RETIRED_STATE (paths relative to ~/.claude), removeRetiredState(ctx, record).
// Invariants (P15): only the paths in RETIRED_STATE are looked at; one is removed only when lstat shows a real folder or file
//   owned by the user who runs the install (no uid check on Windows, which has none); a link there is never followed or removed,
//   only named in a WARNING. A missing path is nothing to do, so a second run changes nothing. Each removal is recorded in the
//   install record (`retiredState`: path and time). --dry-run lists what would go and removes nothing. A failed removal is a
//   WARNING, and the next install tries again. Kept stores (state/question-answered, limits, board, ui-proof...) are not listed.
import { lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { act, note, warn } from './context.mjs';

/** The stores of the removed parts, relative to ~/.claude, as their code at 752f6442 named them. */
export const RETIRED_STATE = Object.freeze([
  'recall', // recall: index.db, checkpoints/, usage.jsonl (the account usage log now lives in state/account)
  'ask', // the ask queue
  'state/estimate', // estimate tables, predictors and per-session files
  'state/estimate-segment', // the status line's estimate segment cache
  'state/estimate-log', // an older estimate log, already unread before the removal
  'state/done-check', // the done-check ledger, blocks and Go base trees
  'state/commit-gate', // commit-gate markers, edit logs and dirty baselines
  'state/call-windows', // the commit-gate call-window logs
  'state/modes', // session-notes mode files
  'state/last-seen', // the status line's last-seen cost for /where
  'state/ui-proof-gate', // the ui-proof-gate hook's once-per-state block keys
]);

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

/** True when `stat` belongs to the user running the install (Windows has no uid: every file counts as the account's own). */
const ownedByUs = (stat) => typeof process.getuid !== 'function' || stat.uid === process.getuid();

/**
 * Removes the stores of removed parts from ~/.claude, once: a removed path is gone, so the next run finds nothing.
 * @param {{claudeDir: string, dryRun: boolean, done: string[]}} ctx the run context
 * @param {{retiredState?: {path: string, removedAt: string}[]}} record the install record (gains one entry per removal)
 * @returns {void}
 */
export function removeRetiredState(ctx, record) {
  for (const relative of RETIRED_STATE) {
    const path = join(ctx.claudeDir, relative);
    const stat = lstatOrNull(path);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !ownedByUs(stat)) {
      warn(`${path} is left as it is: a store of a removed part, but a link or another user's (remove it by hand if it is yours)`);
      continue;
    }
    act(ctx, `remove ${path} (store of a removed part)`, () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        warn(`could not remove ${path} (${error.code ?? error.message}); the next install tries again`);
        return;
      }
      record.retiredState = [...(record.retiredState ?? []), { path, removedAt: new Date().toISOString() }];
      note(ctx, `removed ${path} (store of a removed part)`);
    });
  }
}
