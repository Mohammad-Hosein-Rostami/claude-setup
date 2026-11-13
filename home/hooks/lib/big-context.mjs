// One-time warning for the first big prompt of a session that starts on an already large context.
// Exports: bigContextNote({ mode, prompt, transcriptPath, dir, sessionId }).
// Invariants: only in high / ultra-high; at most once per session (flag file `<dir>/<sessionId>.bigctx`, pruned with
// the mode state files); a failed flag write only means the warning may repeat, reported to stderr; never throws.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { contextTokens } from './transcript.mjs';

const WARN_MODES = ['high', 'ultra-high'];
const BIG_CONTEXT_TOKENS = 60_000;
const BIG_PROMPT_CHARS = 200; // shorter prompts ("ok", "continue") are not a new task
const TOKENS_PER_K = 1000;

/**
 * The note to print for this prompt, or '' when none is due.
 * @param {{mode: string, prompt?: unknown, transcriptPath?: string, dir: string, sessionId?: string}} args - active
 *   mode, the submitted prompt, the transcript path from the hook input, the state directory and safe session id.
 * @returns {Promise<string>} one line telling the lead to ask the user for `/clear` or a new session, or ''.
 */
export async function bigContextNote({ mode, prompt, transcriptPath, dir, sessionId }) {
  if (!sessionId || !WARN_MODES.includes(mode)) return '';
  if (typeof prompt !== 'string' || prompt.startsWith('/') || prompt.trim().length < BIG_PROMPT_CHARS) return '';
  const flag = join(dir, `${sessionId}.bigctx`);
  if (await access(flag).then(() => true, () => false)) return '';
  const tokens = await contextTokens(transcriptPath);
  if (tokens === undefined || tokens <= BIG_CONTEXT_TOKENS) return '';
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(flag, '1\n');
  } catch (error) {
    process.stderr.write(`mode hook: cannot save big-context flag: ${error.message}\n`);
  }
  return `Context is already ~${Math.round(tokens / TOKENS_PER_K)}k tokens and this looks like a new task: before starting, tell the user "/clear or start a new session first" (one task per session; use the \`handoff\` skill if state must carry over).`;
}
