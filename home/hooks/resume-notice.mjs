// SessionStart(startup|resume|compact): tells the lead what work was left open, without any workflow journal: the plain writer agents
// launched with no recorded finish (their folder's dirty-file count; SendMessage before a fresh agent), the open questions of recent ask
// queues with the re-arm line, and the "Don't redo" list of the HANDOFF.md beside the STATUS.md (all from lib/unfinished-work.mjs), then the
// Stop-gate records (`gate overridden`, `gate crashed or timed out`) the last notice did not show (lib/stop-block-count.mjs recordsNotice).
// Exports: noticeFor(input, deps) -> string; deps is { env, estimateStateDir, projectDir, nowMs }.
// Invariants: prints nothing for any other source, for a subagent (`agent_id`), for a bad session id or for input that is not a SessionStart
// JSON; never fails the session start (any error prints nothing, exit 0); output is bounded and carries no prompt text or args.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isSessionId } from './lib/session-store.mjs';
import { recordsNotice } from './lib/stop-block-count.mjs';
import { sessionNotes } from './lib/unfinished-work.mjs';
import { stateDir as estimateStateDir } from '../tools/estimate/lib/table-store.mjs';

const SOURCES = new Set(['startup', 'resume', 'compact']);
const MAX_INPUT_BYTES = 1 << 20;

/**
 * @param {object | null} input the SessionStart hook JSON (session_id, cwd, source)
 * @param {{ env: Record<string, string|undefined>, estimateStateDir: string, projectDir?: string, nowMs: number }} deps
 * @returns {string} the notice, or '' when there is nothing to say
 */
export function noticeFor(input, deps) {
  if (input === null || typeof input !== 'object' || input.agent_id || !SOURCES.has(input.source) || !isSessionId(input.session_id)) return '';
  const { env, estimateStateDir: estimateDir, projectDir, nowMs } = deps;
  const notes = sessionNotes({ sessionId: input.session_id, cwd: input.cwd ?? '', source: input.source, nowMs }, { env, estimateStateDir: estimateDir, projectDir });
  return [notes, recordsNotice(env, nowMs)].filter(Boolean).join('\n');
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return;
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const text = noticeFor(input, { env: process.env, estimateStateDir: estimateStateDir(), projectDir: process.env.CLAUDE_PROJECT_DIR, nowMs: Date.now() });
  if (text !== '') console.log(text);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch {
    // no notice is better than a broken session start
  }
  process.exitCode = 0;
}
