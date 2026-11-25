// Purpose: the one-time cleanup of the state that removed parts of this setup left in ~/.claude (lex-dev-tess plan, 2026-11-24):
//   the recall index, checkpoints and usage log, the ask queue, the estimate tables and caches, the done-check ledger and runs,
//   the commit-gate and call-window logs, the session-mode files, the last-seen costs, the ui-proof-gate blocks, the stop-gate
//   blocks, the agent-budget denials and the MCP discovery verdicts; then (guard-removal plan, 2026-11-25) the removed guards'
//   stores: the Bash guard's remembered allows, answers and bounces, the agent-start record and writer launches, the suite
//   queue's state and the guard decision log with its rotation files; and the removed question popup's stores: its answered marks
//   and the asking markers.
// Exports: RETIRED_STATE (paths relative to ~/.claude), removeRetiredState(ctx, record).
// Invariants (P15): only the paths in RETIRED_STATE are looked at; one is moved only when lstat shows a real folder or file
//   owned by the user who runs the install (no uid check on Windows, which has none); a link there is never followed or moved,
//   only named in a WARNING. Nothing is deleted: a store goes into the install backup folder (~/.claude-backup-<stamp>/) through
//   record.mjs backup(), which names it in the record's `backups`, and the record's `retiredState` names it again (path, backup,
//   time). A missing path is nothing to do, so a second run changes nothing. --dry-run lists what would move and moves nothing.
//   A failed move is a WARNING, and the next install tries again. Kept stores (limits, board, ui-proof...) and ~/.claude/jobs
//   (Claude Code's own) are not listed.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { warn } from './context.mjs';
import { backup } from './record.mjs';

/** The stores of the removed parts, relative to ~/.claude, as their code at 752f6442 named them (the last three: audit R10). */
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
  'state/stop-blocks', // the removed stop-gate's block counts
  'state/budget-denied', // an older agent-budget's denial markers; no code reads or writes them
  'state/mcp-discover-verdicts.json', // the removed MCP discovery's verdicts
  // Guard removal (2026-11-25), as the removed code at 77318f8c names them:
  'state/guard-allowed', // the Bash guard's allowed literals (lib/allowed-literals.mjs)
  'state/guard-answered', // the Bash guard's answered commands (lib/answered-commands.mjs)
  'state/guard-bounced', // the bounce-once digests, also the agent brief gates' (lib/bounce-once.mjs)
  'state/main-agents', // the agent-start route and cap record (lib/main-agents-store.mjs)
  'state/agent-writers', // the writer launch records (lib/agent-launches.mjs, lib/writer-agents.mjs)
  'state/suite', // the suite queue's lock and cache (tools/suite)
  'logs/guard.jsonl', // the guard decision log (lib/guard-log.mjs)
  'logs/guard.1.jsonl', // its one rotated copy
  'logs/guard.1.jsonl.part', // a rotation killed half-way leaves these two temp names
  'logs/guard.jsonl.new',
  'logs/.guard.rotate-lock', // the rotation lock
  // The question popup's removal (2026-11-25), as the removed code at 457a9bda^ and 8571a747^ names them:
  'state/question-answered', // the answered-in-the-terminal marks (lib/question-answered.mjs)
  'state/asking', // the "needs you" asking markers (lib/asking-marker.mjs)
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
 * Moves the stores of removed parts out of ~/.claude into the install backup folder, once: a moved path is gone, so the next
 * run finds nothing. --uninstall puts them back like any other backup.
 * @param {{claudeDir: string, home: string, backupDir: string, dryRun: boolean, done: string[]}} ctx the run context
 * @param {{backups: object[], retiredState?: {path: string, backup: string, removedAt: string}[]}} record the install record
 *   (gains one `backups` and one `retiredState` entry per moved store)
 * @returns {void}
 */
export function removeRetiredState(ctx, record) {
  for (const relative of RETIRED_STATE) {
    const path = join(ctx.claudeDir, relative);
    const stat = lstatOrNull(path);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !ownedByUs(stat)) {
      warn(`${path} is left as it is: a store of a removed part, but a link or another user's (move it away by hand if it is yours)`);
      continue;
    }
    moveToBackup(ctx, record, path);
  }
}

/** One store into the backup folder; a failed move (a busy file, no permission) is a WARNING and the next install tries again. */
function moveToBackup(ctx, record, path) {
  let saved;
  try {
    saved = backup(ctx, record, path);
  } catch (error) {
    warn(`could not move ${path} to the backup folder (${error.code ?? error.message}); the next install tries again`);
    return;
  }
  if (ctx.dryRun) return; // backup() only printed the move
  record.retiredState = [...(record.retiredState ?? []), { path, backup: saved, removedAt: new Date().toISOString() }];
}
