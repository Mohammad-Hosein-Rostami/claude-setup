// SessionStart(compact) hook: after a compaction, print a digest of this session's checkpoint notes (owner instructions,
// open items, decisions, key numbers, files; newest first, at most 6000 chars) so the model starts from what mattered,
// plus the `recall "<query>" --session current` line for exact details. Separate from mode.mjs on purpose (the mode
// output is capped at 9000 chars). If a checkpoint job is still running (PreCompact started one) it waits for it, up
// to RECALL_DIGEST_WAIT_MS (default 8000). The digest names the account the session's last checkpoint call ran on
// (never a token), and when that call had no login (`error: "auth"` in usage.jsonl) it says so, also with no notes.
// Prints nothing when there are no notes and no such failure; never fails the session start.
// With `--part rules` or `--part state` (their own hook entries on SessionStart compact|resume and on PreCompact, so each string has
// its own 10,000-char cap) it prints that part of the session's STATUS.md digest instead (tools/status/status-digest.mjs: every
// active standing rule in full; open rows with next steps, "Don't redo", decisions, git facts). PreCompact stdout is advice to the
// summarizer only; this hook never blocks a compaction (it always exits 0).
// Exports: digestFor, accountLine.
// Invariants: the digest is wrapped in <recall-digest> tags and note text cannot contain such a tag (defanged in buildDigest);
// an account name is shown only when it matches the account tool's name rule; only the last USAGE_TAIL_BYTES of the
// usage log are read, and only from a regular file.
import '../tools/recall/lib/quiet-sqlite-warning.mjs'; // first: it must run before node:sqlite loads
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { lockHeld } from '../tools/recall/lib/checkpoint-state.mjs';
import { buildDigest } from '../tools/recall/lib/digest.mjs';
import { defaultDbPath, usageLogPath } from '../tools/recall/lib/paths.mjs';
import { stateDir as estimateStateDir } from '../tools/estimate/lib/table-store.mjs';
import { statusDigestPart } from '../tools/status/status-digest.mjs';

// Loaded here, not with a static import: Node loads a static `node:sqlite` import (and prints its warning) before any
// module body runs, so the quiet-sqlite-warning import above would be too late.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const DEFAULT_WAIT_MS = 8000;
const POLL_MS = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const READ_NO_WAIT = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0); // Windows has no O_NONBLOCK and no FIFO files
const USAGE_TAIL_BYTES = 256 * 1024; // about 1,000 rows: the session's last call is near the end of the log
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/; // the account tool's NAME_PATTERN (home/tools/account/lib/names.mjs)
const NO_ACCOUNT_LINE = 'Checkpoint notes: the last checkpoint call had no login (error auth), so newer notes are missing; pick an account in the terminal (claude-as <name>).';

/** The last USAGE_TAIL_BYTES of the usage log as text ('' when it is missing or not a regular file). */
function usageTail(env) {
  let fd;
  try {
    fd = openSync(usageLogPath(env), READ_NO_WAIT); // O_NONBLOCK: a FIFO in its place never holds the hook
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return '';
    const { size } = stat;
    const length = Math.min(size, USAGE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * The digest line about the account of this session's last checkpoint call.
 * @param {string} session full session id.
 * @param {object} [env] process env (RECALL_USAGE_LOG, RECALL_STATE_DIR).
 * @returns {string} the account line, the "no login" line after an `auth` failure, or '' when the session made no call
 *   or its account has no valid name (a terminal token with no name).
 */
export function accountLine(session, env = process.env) {
  const rows = usageTail(env).split('\n').reverse();
  for (const line of rows) {
    let row;
    try { row = JSON.parse(line); } catch { continue; } // the first line of the tail is usually cut
    if (row?.session !== session) continue;
    if (row.error === 'auth') return NO_ACCOUNT_LINE;
    return ACCOUNT_NAME.test(row.account ?? '') ? `Checkpoint notes made on account: ${row.account}.` : '';
  }
  return '';
}

/**
 * The digest text for a SessionStart hook input ('' when it is not a main-session compaction or there are no notes).
 * @param {object} input hook JSON (source, session_id, agent_id?).
 * @param {object} [env] process env.
 */
export async function digestFor(input, env = process.env) {
  if (input.source !== 'compact' || input.agent_id || typeof input.session_id !== 'string') return '';
  const wait = Number(env.RECALL_DIGEST_WAIT_MS ?? DEFAULT_WAIT_MS);
  for (const until = Date.now() + wait; lockHeld(input.session_id, env) && Date.now() < until;) await sleep(POLL_MS);
  const account = accountLine(input.session_id, env);
  const digest = notesDigest(input.session_id, env);
  if (!digest) return account === NO_ACCOUNT_LINE ? `<recall-digest>\n${account}\n</recall-digest>` : '';
  return `<recall-digest>\n${digest}${account ? `\n${account}` : ''}\n</recall-digest>`; // its own tag: notes are memory, the model is told so in the header
}

/** The notes digest of one session ('' when there is no index or no notes). */
function notesDigest(session, env) {
  const path = defaultDbPath(env);
  if (!existsSync(path)) return '';
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return buildDigest(db, session);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const input = JSON.parse(raw);
    const partAt = process.argv.indexOf('--part');
    const digest = partAt === -1 ? await digestFor(input)
      : statusDigestPart(process.argv[partAt + 1], input, { stateDir: estimateStateDir(), projectDir: process.env.CLAUDE_PROJECT_DIR });
    if (digest) console.log(digest);
  } catch {
    // no digest is better than a broken session start
  }
}
