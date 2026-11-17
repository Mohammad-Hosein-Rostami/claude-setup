// PostToolUse and PreCompact hook: start a live session checkpoint (Haiku notes of the new transcript tail, stored in
// the recall DB) in a detached job, so a long session never loses decisions, numbers, files or open items when it
// compacts. Triggers when the transcript grew by >= ~40k tokens (bytes / 3.5) since the last checkpoint, and on
// PreCompact (auto and manual) for the remaining tail. Main sessions only: any `agent_id` in the hook input (a subagent)
// is skipped. One job per session: the lock is taken here, before the job starts, so two hooks never start two jobs.
// Never blocks, never prints, never fails a tool call: every error exits 0. Exports: handleCheckpointHook.
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireLock, decideCheckpoint, readCheckpoint, requestPending, takePending } from '../tools/recall/lib/checkpoint-state.mjs';

const EVENTS = new Set(['PostToolUse', 'PreCompact']);
const JOB = fileURLToPath(new URL('../tools/recall/checkpoint-job.mjs', import.meta.url));

/**
 * Decide and, when due, start the detached checkpoint job.
 * @param {object} input the hook JSON (hook_event_name, session_id, transcript_path, agent_id?).
 * @param {object} [env] process env (tests inject RECALL_* settings).
 * @returns {'started' | string} 'started', or the reason nothing was started (for tests); 'pending' when a PreCompact
 *   found a job running and left it a flag to run once more for the tail.
 */
export function handleCheckpointHook(input, env = process.env) {
  if (input.agent_id) return 'subagent';
  if (!EVENTS.has(input.hook_event_name)) return 'event';
  const { session_id: session, transcript_path: transcript } = input;
  if (typeof session !== 'string' || typeof transcript !== 'string' || /[\\/]subagents[\\/]/.test(transcript)) return 'not a main session';
  const size = statSync(transcript).size;
  if (!decideCheckpoint({ event: input.hook_event_name, size, state: readCheckpoint(session, env) })) return 'not due';
  let setPid = acquireLock(session, env);
  if (!setPid && input.hook_event_name === 'PreCompact') {
    // The running job re-checks this flag before and after it releases the lock; if it already released, take over here.
    requestPending(session, env);
    setPid = acquireLock(session, env);
    if (!setPid) return 'pending';
    takePending(session, env);
  }
  if (!setPid) return 'locked';
  const child = spawn(process.execPath, [JOB, session, transcript, input.hook_event_name], { detached: true, stdio: 'ignore', env });
  child.on('error', () => {}); // a spawn failure must not crash the hook; the lock goes stale on its own
  child.unref();
  setPid(child.pid);
  return 'started';
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  try {
    handleCheckpointHook(JSON.parse(raw));
  } catch {
    // a hook must never break the session: unreadable input, a vanished transcript or a full disk all end here
  }
}
