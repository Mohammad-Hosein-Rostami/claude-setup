// SessionStart(startup|resume|compact): tells the lead which workflow runs did not finish (a killed process, a usage-limit stop, an account
// switch) and how to continue each: Workflow({scriptPath, resumeFromRunId}) in the same session, `wf-resume.mjs adopt` first in another one.
// The registry (workflow-register.mjs) and the run folders hold the facts; tools/wf-resume/lib/notice.mjs builds the text.
// It also lists the Stop-gate records (`gate overridden`, `gate crashed or timed out`) the last notice did not show
// (lib/stop-block-count.mjs recordsNotice, which first records gate runs that never returned), and (lib/unfinished-work.mjs,
// spec-p3 `r9-resume`) the plain writer agents launched with no recorded finish (their folder's dirty-file count; SendMessage before a fresh
// agent), the open questions of recent ask queues with the re-arm line, and the "Don't redo" list of the HANDOFF.md beside the STATUS.md.
// Exports: noticeForInput(input, deps) -> string.
// Invariants: prints nothing for any other source, for a subagent (`agent_id`) or for input that is not a SessionStart JSON; never fails the
// session start (any error prints nothing, exit 0); output is bounded and carries no prompt text or args.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSessionId } from './lib/session-store.mjs';
import { recordsNotice } from './lib/stop-block-count.mjs';
import { stateDir as estimateStateDir } from '../tools/estimate/lib/table-store.mjs';
import { resumeNotice } from '../tools/wf-resume/lib/notice.mjs';
import { sessionNotes } from './lib/unfinished-work.mjs';
import { defaultRegistryDir } from '../tools/wf-resume/lib/registry.mjs';

const SOURCES = new Set(['startup', 'resume', 'compact']);
const MAX_INPUT_BYTES = 1 << 20;

/** The folder Claude Code keeps a session's run folders in, next to its transcript; null when the input names no usable transcript. */
const sessionFolderOf = (input) => (isAbsolute(String(input.transcript_path ?? '')) ? join(dirname(input.transcript_path), input.session_id) : null);

/**
 * @param {object | null} input the SessionStart hook JSON (session_id, cwd, transcript_path, source)
 * @param {{ registryDir: string, projectsRoot: string, estimateStateDir: string, projectDir?: string, nowMs: number }} deps
 * @returns {string} the notice, or '' when there is nothing to say
 */
export function noticeForInput(input, deps) {
  if (input === null || typeof input !== 'object' || input.agent_id || !SOURCES.has(input.source) || !isSessionId(input.session_id)) return '';
  const { registryDir, projectsRoot, estimateStateDir: estimateDir, projectDir, nowMs } = deps;
  return resumeNotice({ sessionId: input.session_id, cwd: input.cwd ?? '', sessionFolder: sessionFolderOf(input), source: input.source, nowMs }, { registryDir, projectsRoot, estimateStateDir: estimateDir, projectDir });
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return;
    chunks.push(chunk);
  }
  const projectsRoot = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const text = noticeForInput(input, {
    registryDir: defaultRegistryDir(), projectsRoot, estimateStateDir: estimateStateDir(), projectDir: process.env.CLAUDE_PROJECT_DIR, nowMs: Date.now(),
  });
  const leadStart = input !== null && typeof input === 'object' && !input.agent_id && SOURCES.has(input.source);
  const stops = leadStart ? recordsNotice(process.env) : '';
  const notes = leadStart && isSessionId(input.session_id)
    ? sessionNotes({ sessionId: input.session_id, cwd: input.cwd ?? '', source: input.source, nowMs: Date.now() }, { env: process.env, estimateStateDir: estimateStateDir(), projectDir: process.env.CLAUDE_PROJECT_DIR })
    : '';
  const lines = [text, notes, stops].filter((part) => part !== '');
  if (lines.length > 0) console.log(lines.join('\n'));
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
