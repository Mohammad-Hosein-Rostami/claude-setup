// PermissionRequest(AskUserQuestion): the question popup. Claude Code runs this hook beside its own question UI; lib/question-reply.mjs
// shows one timed popup per question, each with its own CLAUDE_QUESTION_TIMEOUT_S wait (default 120 s), and closes it at once when the
// owner answers in the terminal (the PostToolUse hook question-answered.mjs leaves the mark) or when Claude Code stops this hook.
// Its decision is an allow with updatedInput = the input plus `answers`; no answer takes the "(Recommended)" option. "Answer in
// terminal" (or Esc on macOS), no GUI or a failed dialog print nothing: Claude Code's own question UI (settings askUserQuestionTimeout
// still applies there), never an invented answer.
// Exports: none (run as a hook).
// Invariants: never throws out of main; any other tool or input that is not hook JSON prints nothing.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { questionReply } from './lib/question-reply.mjs';
import { installDialogCleanup } from './lib/timed-ask-async.mjs';

const QUESTION_TOOL = 'AskUserQuestion';

/** @returns {string} the hook JSON line that answers the prompt */
const replyLine = (decision) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })}\n`;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // not hook JSON: leave the prompt alone
  }
  if (input?.tool_name !== QUESTION_TOOL) return; // not a question: Claude Code's own prompt
  installDialogCleanup(); // Claude Code stopping this hook must not leave a popup open
  const decision = await questionReply(input, process.env);
  process.stdout.write(decision ? replyLine(decision) : '');
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
