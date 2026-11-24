// PermissionRequest: every Claude Code permission prompt gets the timed native dialog of lib/timed-ask.mjs with a
// CLAUDE_PERMISSION_TIMEOUT_S (default 120, at most 190) wait: no answer -> allow, Allow click -> allow, Deny click -> deny. The owner's
// rule is "everything should be auto yes, now 2 min": any tool (built-in, MCP, Agent, ExitPlanMode plan approval, protected-file writes,
// a team's ask rules), any permission mode, and any session kind (interactive, background agents, `claude -p`, where Claude Code runs
// this hook too and denies when no hook decides). No GUI (ssh, CI, tests) or a failed dialog prints nothing: Claude Code's normal
// behaviour (its prompt, or a deny where nobody can be asked).
// Exports: permissionReply(input, env, answer) -> hook stdout (every tool except AskUserQuestion).
// AskUserQuestion (the owner: "nothing should wait for me") is answered by lib/question-reply.mjs from main: one timed popup PER question,
// each with its own CLAUDE_QUESTION_TIMEOUT_S wait, closed at once when the owner turns the question down in the terminal
// (lib/question-rejected.mjs) or when Claude Code stops this hook. Its decision is an allow with updatedInput = the input plus
// `answers`; "Answer in terminal" (or Esc on macOS), no GUI or a failed dialog print nothing: Claude Code's own question UI
// (settings askUserQuestionTimeout still applies there), never an invented answer.
// ExitPlanMode needs updatedInput with an allow (hooks docs), so its allow echoes the plan input back.
// The input carries no prompt reason, so the dialog says what the tool asks to do, in which mode, and that Claude Code gave no reason;
// for Bash it also runs the guard's rules (pre-bash-guard.mjs decideSafely) and for Artifact the Artifact hook's (artifact-ask.mjs
// decideArtifact), and shows that hook's own reason when it asks, so an ask whose own dialog failed is never shown under a generic reason.
// A Bash command the guard's dialog allowed moments before (same session, agent, directory and command, 10 s, used once,
// lib/answered-commands.mjs) is allowed without a second dialog, unless the guard classes it as DESTRUCTIVE: that one always gets this
// dialog, so a forged record cannot let it through unseen. A deny rule still wins over an allow (hooks docs); an ask rule is a
// prompt like any other and gets the dialog. A JSON input (MCP and other tools) is shown and logged with its secret-named fields masked
// (lib/secrets.mjs maskSecretFields). Invariants: never throws out of main; every answered prompt is logged to the guard log.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { takeAnswered } from './lib/answered-commands.mjs';
import { logDecision } from './lib/guard-log.mjs';
import { readProdHosts } from './lib/remote.mjs';
import { maskSecretFields } from './lib/secrets.mjs';
import { questionReply } from './lib/question-reply.mjs';
import { installDialogCleanup } from './lib/timed-ask-async.mjs';
import { answerAsk, permissionTimeoutSeconds } from './lib/timed-ask.mjs';
import { DESTRUCTIVE_PREFIX } from './lib/verdict.mjs';
import { decideArtifact } from './artifact-ask.mjs';
import { decide, decideSafely } from './pre-bash-guard.mjs';

const QUESTION_TOOL = 'AskUserQuestion';
const NEEDS_UPDATED_INPUT = ['ExitPlanMode']; // an allow without updatedInput is ignored for it
const HOOK_NAME = 'permission-timed-allow';
// [tool_input field, dialog label], first match wins; any other input is shown as JSON under "Input"
const TARGET_FIELDS = [
  ['command', 'Command'], ['file_path', 'File'], ['notebook_path', 'File'], ['path', 'Path'], ['url', 'URL'], ['query', 'Query'],
  ['pattern', 'Pattern'], ['plan', 'Plan'], ['prompt', 'Prompt'],
];
const RUN_COMMAND = 'run this command';
const ACTIONS = {
  Bash: RUN_COMMAND, PowerShell: RUN_COMMAND, Monitor: RUN_COMMAND,
  Edit: 'change this file', MultiEdit: 'change this file', Write: 'write this file', NotebookEdit: 'change this notebook',
  Read: 'read this path', Glob: 'list files here', Grep: 'search files here',
  WebFetch: 'fetch this URL', WebSearch: 'search the web',
  Agent: 'start a subagent', Task: 'start a subagent', ExitPlanMode: 'leave plan mode and carry out this plan',
};
const BYPASS_NOTE = 'a built-in safety check such as a protected file or "Dangerous rm operation not ruled out"';

/** @returns {string} the hook JSON line that answers the prompt */
const replyLine = (decision) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })}\n`;

/** @returns {{label: string, text: string}} what the call acts on (command, file, URL, query ...) and its dialog label */
function targetOf(toolInput) {
  const found = TARGET_FIELDS.find(([field]) => typeof toolInput?.[field] === 'string');
  if (found) return { label: found[1], text: toolInput[found[0]] };
  try {
    return { label: 'Input', text: maskSecretFields(toolInput) };
  } catch {
    return { label: 'Input', text: '(input not shown: it cannot be written as JSON)' };
  }
}

/** @returns {string} what the tool asks to do, in which mode; Claude Code passes hooks no reason of its own */
function promptReason(tool, mode) {
  const action = ACTIONS[tool] ?? (tool.startsWith('mcp__') ? `call MCP tool ${tool}` : `use ${tool}`);
  const modeText = typeof mode === 'string' ? mode : 'unknown';
  const note = mode === 'bypassPermissions' ? `, ${BYPASS_NOTE}` : '';
  return `Claude Code asks permission to ${action} (${modeText} mode${note}; Claude Code gives hooks no reason)`;
}

/** @returns {string | undefined} the Bash guard's reason when its rules ask about this command (same rules, prod hosts included) */
function guardReason(command, cwd, env) {
  const rules = (text, ctx) => decide(text, { ...ctx, prodHosts: readProdHosts() });
  const verdict = decideSafely(command, { cwd, project: env.CLAUDE_PROJECT_DIR || cwd }, rules);
  if (!verdict.ask) return undefined;
  return verdict.errorClass ? `${verdict.reason}: ${verdict.errorClass}` : verdict.reason;
}

/**
 * Answers one PermissionRequest.
 * @param {{tool_name?: string, tool_input?: object, permission_mode?: string, cwd?: string, session_id?: string, agent_id?: string}} input hook JSON
 * @param {Record<string, string | undefined>} env process environment (timeout, GUI detection, HOME, log path, CLAUDE_PROJECT_DIR)
 * @param {typeof answerAsk} answer the dialog (lib/timed-ask.mjs answerAsk; a test passes a fake)
 * @returns {string} an allow or deny line, or '' to leave the prompt to Claude Code
 */
export function permissionReply(input, env = process.env, answer = answerAsk) {
  const tool = input?.tool_name;
  if (typeof tool !== 'string' || tool === '') return '';
  if (tool === QUESTION_TOOL) return ''; // answered by questionReply in main: its popups are asynchronous
  const { label, text } = targetOf(input.tool_input);
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd(); // the guard keys its records the same way
  const record = { hook: HOOK_NAME, tool, command: text, cwd, session: input.session_id };
  const allow = NEEDS_UPDATED_INPUT.includes(tool) ? { behavior: 'allow', updatedInput: input.tool_input } : { behavior: 'allow' };
  const isBash = tool === 'Bash' && label === 'Command';
  const guard = isBash ? guardReason(text, cwd, env) : undefined;
  const handOver = isBash && !guard?.startsWith(DESTRUCTIVE_PREFIX); // a destructive command always gets the dialog
  if (handOver && takeAnswered({ session: input.session_id, agentId: input.agent_id, cwd, command: text }, env)) {
    logDecision({ ...record, decision: 'allow', outcome: 'guard-answered', reason: 'the guard dialog answered it' }, env);
    return replyLine(allow);
  }
  const artifact = tool === 'Artifact' ? decideArtifact(input.tool_input) : undefined;
  const hookReason = guard ? `Bash guard: ${guard}` : artifact && `Artifact hook: ${artifact}`;
  const reason = hookReason ? `${hookReason}. ${promptReason(tool, input.permission_mode)}` : promptReason(tool, input.permission_mode);
  const request = { tool, reason, command: text, targetLabel: label, timeoutS: permissionTimeoutSeconds(env), cwd, sessionId: input.session_id, agentId: input.agent_id };
  const result = answer(request, env);
  logDecision({ ...record, decision: result.decision, outcome: result.outcome, reason }, env);
  if (result.decision === 'allow') return replyLine(allow);
  if (result.decision === 'deny') return replyLine({ behavior: 'deny', message: result.reason });
  return ''; // no GUI or the dialog failed: Claude Code's own prompt, or its deny where nobody can be asked
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
  if (input?.tool_name === QUESTION_TOOL) {
    installDialogCleanup(); // Claude Code stopping this hook must not leave a popup open
    const decision = await questionReply(input, process.env);
    process.stdout.write(decision ? replyLine(decision) : '');
    return;
  }
  process.stdout.write(permissionReply(input));
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
