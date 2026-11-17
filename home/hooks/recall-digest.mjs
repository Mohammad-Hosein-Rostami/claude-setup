// SessionStart(compact) hook: after a compaction, print a digest of this session's checkpoint notes (owner instructions,
// open items, decisions, key numbers, files; newest first, at most 6000 chars) so the model starts from what mattered,
// plus the `recall "<query>" --session current` line for exact details. Separate from mode.mjs on purpose (the mode
// output is capped at 9000 chars). If a checkpoint job is still running (PreCompact started one) it waits for it, up
// to RECALL_DIGEST_WAIT_MS (default 8000). Prints nothing when there are no notes; never fails the session start.
// Exports: digestFor.
// Invariants: the digest is wrapped in <recall-digest> tags and note text cannot contain such a tag (defanged in buildDigest).
import '../tools/recall/lib/quiet-sqlite-warning.mjs'; // first: it must run before node:sqlite loads
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { lockHeld } from '../tools/recall/lib/checkpoint-state.mjs';
import { buildDigest } from '../tools/recall/lib/digest.mjs';
import { defaultDbPath } from '../tools/recall/lib/paths.mjs';

// Loaded here, not with a static import: Node loads a static `node:sqlite` import (and prints its warning) before any
// module body runs, so the quiet-sqlite-warning import above would be too late.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const DEFAULT_WAIT_MS = 8000;
const POLL_MS = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The digest text for a SessionStart hook input ('' when it is not a main-session compaction or there are no notes).
 * @param {object} input hook JSON (source, session_id, agent_id?).
 * @param {object} [env] process env.
 */
export async function digestFor(input, env = process.env) {
  if (input.source !== 'compact' || input.agent_id || typeof input.session_id !== 'string') return '';
  const wait = Number(env.RECALL_DIGEST_WAIT_MS ?? DEFAULT_WAIT_MS);
  for (const until = Date.now() + wait; lockHeld(input.session_id, env) && Date.now() < until;) await sleep(POLL_MS);
  const path = defaultDbPath(env);
  if (!existsSync(path)) return '';
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const digest = buildDigest(db, input.session_id);
    return digest ? `<recall-digest>\n${digest}\n</recall-digest>` : ''; // its own tag: notes are memory, the model is told so in the header
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const digest = await digestFor(JSON.parse(raw));
    if (digest) console.log(digest);
  } catch {
    // no digest is better than a broken session start
  }
}
