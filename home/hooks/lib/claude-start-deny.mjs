// The Bash guard's one deny (plan M2b): max prepares only, so a Claude Code session or a long-run started from its work is denied every
// time, with no dialog and no bounce. A session started there is a new session that names no max, so its outward asks would get the
// timed allow and could outlive max's click rule (lib/click-only.mjs).
// Whose work: a call of max itself (the hook input's agent_type), or of any subagent (it has an agent_id) while a max runs on this
// machine (lib/main-agents-store.mjs anyRunning; an unreadable record counts as running: fail closed). A helper of max has its own
// agent_type, so only the record shows it works for max. The main session's own calls (no agent_id) are never denied here.
// Exports: CLAUDE_START_REASON, CLAUDE_START_OUTCOME, claudeStartDeny(command, input, env) -> hook stdout line or ''.
// Invariants: the max record is read only for a line that starts a session (lib/claude-starts.mjs, pure), so other calls stay cheap.
import { lineStartsClaude } from './claude-starts.mjs';
import { CLICK_ONLY_AGENT_TYPE } from './click-only.mjs';
import { logDecision } from './guard-log.mjs';
import { anyRunning } from './main-agents-store.mjs';
import { decisionOutput } from './timed-ask.mjs';

export const CLAUDE_START_REASON = 'max prepares only: a Claude session or long-run started from its work would act outside the owner\'s '
  + 'click rule; put the command in the commands file';
export const CLAUDE_START_OUTCOME = 'claude-start'; // the guard log's outcome for this deny

/** True when the call is max's own, or a subagent's while a max runs (see the header). */
function isMaxWork(input, env) {
  if (input.agent_type === CLICK_ONLY_AGENT_TYPE) return true;
  return Boolean(input.agent_id) && anyRunning(CLICK_ONLY_AGENT_TYPE, env) !== 'no';
}

/**
 * The deny for a Claude Code session or long-run start from max's work, logged to the guard log.
 * @param {string} command the Bash command line
 * @param {{agent_type?: unknown, agent_id?: unknown, session_id?: string, cwd?: string}} input the PreToolUse hook input
 * @param {Record<string, string | undefined>} env process environment (HOME for the max record, the guard log)
 * @returns {string} the hook's deny line; '' when the line starts no session or the call is not max's work
 */
export function claudeStartDeny(command, input, env = process.env) {
  if (!lineStartsClaude(command) || !isMaxWork(input, env)) return '';
  const tool = typeof input.tool_name === 'string' ? input.tool_name : 'Bash';
  logDecision({ hook: 'pre-bash-guard', tool, decision: 'deny', outcome: CLAUDE_START_OUTCOME, reason: CLAUDE_START_REASON, command, cwd: input.cwd, session: input.session_id }, env);
  return decisionOutput({ decision: 'deny', reason: CLAUDE_START_REASON });
}
