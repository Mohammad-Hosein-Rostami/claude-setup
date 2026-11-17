// PostToolUse(AskUserQuestion): records that a question was answered, so the PermissionRequest hook (permission-timed-allow.mjs) closes
// the popups still open for it. Claude Code runs the terminal question and that hook side by side and tells the hook nothing when the
// owner answers in the terminal; PostToolUse fires once the tool has run, whoever answered.
// Exports: markAnswered(input, env) -> void. Prints nothing and always exits 0: it must never change what Claude sees.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { markQuestionAnswered, questionTexts } from './lib/question-answered.mjs';

const QUESTION_TOOL = 'AskUserQuestion';

/**
 * @param {{tool_name?: string, tool_input?: object, session_id?: string, agent_id?: string}} input PostToolUse hook JSON
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @returns {void}
 */
export function markAnswered(input, env = process.env) {
  if (input?.tool_name !== QUESTION_TOOL) return;
  const questions = questionTexts(input.tool_input);
  if (questions) markQuestionAnswered({ session: input.session_id, agentId: input.agent_id, questions }, env);
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    markAnswered(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    // not hook JSON: nothing to mark
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
