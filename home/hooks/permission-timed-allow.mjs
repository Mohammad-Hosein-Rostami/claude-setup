// PermissionRequest: Claude Code's own permission prompts that still appear in bypassPermissions mode (for example a Bash command
// flagged "Dangerous rm operation not ruled out", a critical-path removal, an explicit ask rule) get the timed native dialog of
// lib/timed-ask.mjs with a CLAUDE_PERMISSION_TIMEOUT_S (default 30, at most 190) wait: no answer -> allow, Allow click -> allow,
// Deny click -> deny. No GUI (ssh, CI, tests) or a failed dialog prints nothing, so Claude Code shows its normal prompt.
// Exports: PERMISSION_TOOLS, permissionReply(input, env, answer) -> hook stdout.
// Scope: only the tools in PERMISSION_TOOLS (the same list is the matcher in settings/base.json) and only in bypassPermissions mode;
// AskUserQuestion, ExitPlanMode, MCP and Agent calls are questions or other flows, never answered here, and other modes keep their prompts.
// A Bash command the guard (pre-bash-guard.mjs) asked about and the owner allowed moments before is allowed without a second dialog
// (lib/answered-commands.mjs). Deny and ask rules still apply after an allow (Claude Code evaluates them, per the hooks docs).
// The input carries no prompt reason (docs: tool_name, tool_input, permission_mode, permission_suggestions), so the dialog names the
// tool and its command or path. Invariants: never throws out of main; every answered prompt is logged to the guard decision log.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { takeAnswered } from './lib/answered-commands.mjs';
import { logDecision } from './lib/guard-log.mjs';
import { answerAsk, ASK_TIMEOUT_ENV, permissionTimeoutSeconds } from './lib/timed-ask.mjs';

export const PERMISSION_TOOLS = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
const BYPASS_MODE = 'bypassPermissions';
const HOOK_NAME = 'permission-timed-allow';
const PROMPT_REASON = 'Claude Code permission prompt in bypass mode (a built-in safety check such as "Dangerous rm operation not ruled out")';
const TARGET_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'query', 'path', 'pattern'];

/** @returns {string} the hook JSON line that answers the prompt */
const replyLine = (decision) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })}\n`;

/** @returns {string} what the call acts on (command, file, URL, query) for the dialog, or '' */
function targetOf(toolInput) {
  const field = TARGET_FIELDS.find((name) => typeof toolInput?.[name] === 'string');
  return field ? toolInput[field] : '';
}

/**
 * Answers one PermissionRequest.
 * @param {{tool_name?: string, tool_input?: object, permission_mode?: string, cwd?: string, session_id?: string, agent_id?: string}} input hook JSON
 * @param {Record<string, string | undefined>} env process environment (timeout, GUI detection, HOME, log path)
 * @param {typeof answerAsk} answer the dialog (lib/timed-ask.mjs answerAsk; a test passes a fake)
 * @returns {string} an allow or deny line, or '' to leave the prompt to Claude Code
 */
export function permissionReply(input, env = process.env, answer = answerAsk) {
  const tool = input?.tool_name;
  if (!PERMISSION_TOOLS.includes(tool) || input.permission_mode !== BYPASS_MODE) return '';
  const command = targetOf(input.tool_input);
  const record = { hook: HOOK_NAME, tool, command, cwd: input.cwd, session: input.session_id };
  if (tool === 'Bash' && takeAnswered(input.session_id, command, env)) {
    logDecision({ ...record, decision: 'allow', outcome: 'guard-answered', reason: PROMPT_REASON }, env);
    return replyLine({ behavior: 'allow' });
  }
  const askEnv = { ...env, [ASK_TIMEOUT_ENV]: String(permissionTimeoutSeconds(env)) };
  const result = answer({ tool, reason: PROMPT_REASON, command, cwd: input.cwd, sessionId: input.session_id, agentId: input.agent_id }, askEnv);
  logDecision({ ...record, decision: result.decision, outcome: result.outcome, reason: PROMPT_REASON }, env);
  if (result.decision === 'allow') return replyLine({ behavior: 'allow' });
  if (result.decision === 'deny') return replyLine({ behavior: 'deny', message: result.reason });
  return ''; // no GUI or the dialog failed: Claude Code's own prompt
}

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
  process.stdout.write(permissionReply(input));
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
