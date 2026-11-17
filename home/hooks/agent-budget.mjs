// PostToolUse (all tools), PreToolUse Bash, SubagentStart and SubagentStop: enforces the budgets the prompt only asked for.
//   PostToolUse in a subagent -> counts its tool calls; the first call that sees 80 or more injects "commit what is green"
//                   once (a marker file next to the counter), at 120 (and every 10 after) it injects "commit, then
//                   return your status report". Advisory: it never blocks a call.
//   PostToolUse Read in the lead, mode ultra-high -> warns when the result is over ~20k chars (use scout / a small range).
//   PostToolUse Bash in the lead -> every 15 Bash calls since the last Agent/Task/Workflow call, a nudge to delegate that states the
//                   context size (lib/transcript.mjs contextTokens); an Agent/Task/Workflow call resets the count. A nudge followed by
//                   another Bash call (no Agent/Task call between) counts as ignored, in a per-session file next to the count.
//   PreToolUse Bash in the lead -> after 2 ignored nudges, at 150k+ context, the next lead Bash call that is not git or
//                   read-only (lib/read-only-command.mjs) is denied once with "delegate to runner/implementer" (lib/bounce-once.mjs
//                   adviceOnce with a store of its own, ~/.claude/state/budget-denied: the identical retry runs; the guard's bounce store
//                   is never touched, so the guard's own bounce of that call still comes) and the ignored count starts over, so it never loops. Subagents are
//                   never blocked; an unknown context size never denies.
//   SubagentStop -> blocks once when the final report is over the cap the spawn prompt states (first user message of the
//                   agent transcript); no stated cap means no check, so agents that return data are never sent back.
//                   A stop it lets through also ends the agent's launch in lib/writer-agents.mjs (agent-model-guard's writer gate).
//   SubagentStart -> marks the agent's pending launch started in lib/writer-agents.mjs (a launch never started stops counting soon).
// Verified against Claude Code 2.1.323: hook input has `agent_id` only inside a subagent (agent_type alongside it);
// PostToolUse accepts hookSpecificOutput.additionalContext; SubagentStop gets agent_id, agent_type, agent_transcript_path,
// last_assistant_message and stop_hook_active, and exit 2 sends stderr to the subagent and keeps it running.
// Exports: CALL_CAP, EARLY_NOTICE_AT, REMIND_EVERY, READ_WARN_CHARS, LEAD_BASH_NUDGE_AT, ESCALATE_AT_TOKENS, countCall, leadBashCalls,
// leadBashDeny, readChars, postToolUseContext, spawnCap, subagentStopReason.
// Invariants: fast (one append + one stat per call, nothing else on the main thread except Read); fails open (any error
// exits 0, silent); output is fixed text plus numbers, never tool input, tool output or paths; unsafe ids write nothing.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempRoot } from './lib/edit-log.mjs';
import { overCap, parseCap } from './lib/reply-cap.mjs';
import { isReadOnlyCommand } from './lib/read-only-command.mjs';
import { contextTokens } from './lib/transcript.mjs';
import { callCounterPath, recordWriterStart, recordWriterStop } from './lib/writer-agents.mjs';

// The agent files (implementer, ui-implementer, test-writer) and the lead rules say "about 120 tool calls"; a test keeps them equal.
export const CALL_CAP = 120;
export const EARLY_NOTICE_AT = 80;
export const REMIND_EVERY = 10;
export const READ_WARN_CHARS = 20_000;
export const LEAD_BASH_NUDGE_AT = 15;
export const ESCALATE_AT_TOKENS = 150_000; // cost = calls x context: from here one lead call costs what ~10 calls of a fresh agent do
const IGNORED_NUDGES_TO_DENY = 2;
const IGNORED_SUFFIX = '.ignored'; // next to the lead Bash count: nudges the lead went on past
const TOKENS_PER_K = 1000;
const NOTICE_SUFFIX = '.notice'; // marker next to the counter file: the early notice was given
const SPAWN_PROMPT_BYTES = 512 * 1024;
const SAFE_ID = /^[\w-]{1,128}$/;
const ULTRA_HIGH = 'ultra-high';
const DELEGATING_TOOLS = new Set(['Agent', 'Task', 'Workflow']); // the owner rule: workflows are how agents run, so a Workflow call is a delegation too

const budgetPath = callCounterPath; // its mtime is also the writer gate's sign that the agent still works

/**
 * Counts one tool call of a subagent: appends one byte and reads the file size, so parallel calls never lose a count.
 * @param {string | null} path counter file (null for unsafe ids)
 * @returns {number} calls so far, 0 when it cannot be counted
 */
export function countCall(path) {
  if (!path) return 0;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, '.');
  return statSync(path).size;
}

/**
 * Claims the one early notice of an agent: the first caller creates the marker file, every later caller finds it.
 * Exclusive create is atomic, so parallel calls that all see a count past 80 still give the notice exactly once.
 * @param {string | null} path counter file (null for unsafe ids)
 * @returns {boolean} true for the one caller that may print the notice
 */
function claimEarlyNotice(path) {
  if (!path) return false;
  try {
    closeSync(openSync(`${path}${NOTICE_SUFFIX}`, 'wx'));
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error; // main() fails open
  }
}

const leadBashPath = (sessionId) => join(tempRoot(), 'lead-bash', sessionId);
const ignoredPath = (sessionId) => `${leadBashPath(sessionId)}${IGNORED_SUFFIX}`;
const kTokens = (tokens) => `~${Math.round(tokens / TOKENS_PER_K)}k`;

/** Nudges the lead went on past this session (since the last deny); 0 when there is no file. */
function ignoredNudges(sessionId) {
  try {
    return statSync(ignoredPath(sessionId)).size;
  } catch {
    return 0; // no file yet
  }
}

/**
 * Counts one lead Bash call since the last Agent/Task/Workflow call, or resets the count when `tool` delegates.
 * @param {string} sessionId hook input session id
 * @param {string} tool tool name: 'Bash' counts, Agent, Task or Workflow resets, anything else is ignored
 * @returns {number} Bash calls since the last delegation (0 for other tools or an unsafe id)
 */
export function leadBashCalls(sessionId, tool) {
  if (!SAFE_ID.test(sessionId ?? '')) return 0;
  const path = leadBashPath(sessionId);
  if (DELEGATING_TOOLS.has(tool)) {
    rmSync(path, { force: true });
    return 0;
  }
  return tool === 'Bash' ? countCall(path) : 0;
}

/**
 * The nudge after one lead Bash, Agent or Task call, or null. Counts an ignored nudge when this Bash call comes right after one.
 * @param {object} input PostToolUse hook JSON of the lead (session_id, tool_name, transcript_path)
 * @returns {Promise<string | null>}
 */
async function leadBashNudge(input) {
  const calls = leadBashCalls(input.session_id, input.tool_name);
  if (calls > LEAD_BASH_NUDGE_AT && calls % LEAD_BASH_NUDGE_AT === 1) countCall(ignoredPath(input.session_id));
  if (calls === 0 || calls % LEAD_BASH_NUDGE_AT !== 0) return null;
  const tokens = await contextTokens(input.transcript_path);
  const size = tokens === undefined ? '(context size unknown)' : `at ${kTokens(tokens)} context`;
  const nudge = `${calls} Bash calls in a row ${size}: delegate the rest to runner/implementer (cost = calls x context).`;
  const ignored = ignoredNudges(input.session_id);
  if (ignored < IGNORED_NUDGES_TO_DENY - 1) return nudge;
  return `${nudge} ${ignored} nudge${ignored === 1 ? '' : 's'} ignored so far; if this one is ignored too, the next lead Bash call that `
    + `is not git or read-only is denied once (at ${ESCALATE_AT_TOKENS / TOKENS_PER_K}k+ context).`;
}

/**
 * The escalation (see the header): the deny for the lead's next non-read-only Bash call after 2 ignored nudges at 150k+ context.
 * @param {object} input PreToolUse hook JSON (session_id, agent_id?, tool_input.command, cwd, transcript_path)
 * @param {Record<string, string | undefined>} env HOME (the advice store), CLAUDE_GUARD_LOG
 * @returns {Promise<string>} the deny JSON line, or '' (the call runs)
 */
export async function leadBashDeny(input, env = process.env) {
  const command = input?.tool_input?.command;
  if (input.agent_id || input.tool_name !== 'Bash' || !SAFE_ID.test(input.session_id ?? '') || typeof command !== 'string') return '';
  const ignored = ignoredNudges(input.session_id);
  if (ignored < IGNORED_NUDGES_TO_DENY || isReadOnlyCommand(command)) return '';
  const tokens = await contextTokens(input.transcript_path);
  if (tokens === undefined || tokens < ESCALATE_AT_TOKENS) return '';
  const advice = `${kTokens(tokens)} context and ${ignored} delegate nudges ignored: delegate to runner/implementer `
    + '(C: cost = calls × context). git and read-only commands stay with the lead.';
  const { adviceOnce } = await import('./lib/bounce-once.mjs');
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const store = join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'budget-denied'); // never the guard's: see adviceOnce
  const deny = adviceOnce([advice], { command, cwd, input, hook: 'agent-budget', tool: 'Bash', store }, env);
  if (deny !== '') rmSync(ignoredPath(input.session_id), { force: true }); // one deny per escalation: never a loop
  return deny;
}

/** Characters in a Read result (file content when present, else the serialized response). */
export function readChars(response) {
  if (typeof response === 'string') return response.length;
  const content = response?.file?.content ?? response?.content;
  return typeof content === 'string' ? content.length : JSON.stringify(response ?? '').length;
}

const sessionMode = (sessionId) => {
  if (!/^[\w-]+$/.test(sessionId ?? '')) return process.env.CLAUDE_MODE;
  try {
    return readFileSync(join(homedir(), '.claude', 'state', 'modes', sessionId), 'utf8').trim();
  } catch {
    return process.env.CLAUDE_MODE; // no saved state: the launch env is the next best source
  }
};

/**
 * Context to inject after a tool call, or null.
 * @param {object} input PostToolUse hook JSON
 * @returns {Promise<string | null>}
 */
export async function postToolUseContext(input) {
  if (input.agent_id) {
    const path = budgetPath(input.session_id, input.agent_id);
    const calls = countCall(path);
    // "80 or more", not "exactly 80": parallel calls can step the count past 80 without any call seeing 80.
    if (calls >= EARLY_NOTICE_AT && calls < CALL_CAP && claimEarlyNotice(path)) {
      return `Budget: ${EARLY_NOTICE_AT} tool calls used. Commit what is green now. If the brief will not be finished by about ${CALL_CAP} calls, pick the stopping point and write down the exact next step.`;
    }
    const due = calls === CALL_CAP || (calls > CALL_CAP && calls % REMIND_EVERY === 0);
    return due
      ? `Budget: ${calls} tool calls used (limit ${CALL_CAP}). Commit what is green, then return your status report: done, not done with the exact next step, files changed, blockers. Do not end without the report; start no new work.`
      : null;
  }
  if (input.tool_name === 'Bash' || DELEGATING_TOOLS.has(input.tool_name)) return leadBashNudge(input);
  if (input.tool_name !== 'Read' || sessionMode(input.session_id) !== ULTRA_HIGH) return null;
  const chars = readChars(input.tool_response);
  return chars > READ_WARN_CHARS
    ? `That Read returned about ${Math.round(chars / 1000)}k chars (warn at ${READ_WARN_CHARS / 1000}k). In ultra-high the lead does not read bulk files: have scout return a digest of at most 3k chars plus the file path, or read a small range with offset and limit.`
    : null;
}

/**
 * The cap the spawn prompt names: first user message of the agent transcript.
 * @param {unknown} transcriptPath agent_transcript_path (empty when unavailable)
 * @returns {{limit: number, unit: string} | null}
 */
export function spawnCap(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const fd = openSync(transcriptPath, 'r');
  let head;
  try {
    const buf = Buffer.alloc(Math.min(statSync(transcriptPath).size, SPAWN_PROMPT_BYTES));
    readSync(fd, buf, 0, buf.length, 0);
    head = buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
  for (const line of head.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // partial or corrupt line
    }
    if (entry?.message?.role !== 'user') continue;
    const content = entry.message.content;
    const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : []).map((b) => b?.text ?? '').join('\n');
    return parseCap(text);
  }
  return null;
}

/**
 * Why a subagent may not stop yet, or null.
 * @param {object} input SubagentStop hook JSON
 * @returns {string | null} message for the subagent when its report is over the cap its spawn prompt states
 */
export function subagentStopReason(input) {
  if (input.stop_hook_active === true || !input.agent_id || typeof input.last_assistant_message !== 'string') return null;
  let cap = null;
  try {
    cap = spawnCap(input.agent_transcript_path);
  } catch {
    // transcript unreadable: no stated cap, so no check
  }
  if (!cap) return null;
  const { over, size } = overCap(input.last_assistant_message, cap);
  return over
    ? `Your final report is ${size} ${cap.unit}; the cap is ${cap.limit} ${cap.unit}. Rewrite it within the cap: verdict first, put detail in a file and give its path.`
    : null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input?.hook_event_name === 'PreToolUse') {
    process.stdout.write(await leadBashDeny(input));
  } else if (input?.hook_event_name === 'PostToolUse') {
    const additionalContext = await postToolUseContext(input);
    if (additionalContext) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }));
  } else if (input?.hook_event_name === 'SubagentStart') {
    recordWriterStart(input.session_id, input.agent_id, input.agent_type, process.env); // agent-model-guard's writer gate: it really runs
  } else if (input?.hook_event_name === 'SubagentStop') {
    const path = budgetPath(input.session_id, input.agent_id);
    const reason = subagentStopReason(input);
    if (reason) {
      // blocked: the agent keeps running and its calls must keep counting
      process.stderr.write(`${reason}\n`);
      process.exitCode = 2;
    } else {
      recordWriterStop(input.session_id, input.agent_id, input.agent_type, process.env); // agent-model-guard's writer gate: it finished
      if (path) {
        // the agent is ending: its counter and notice marker are done
        rmSync(path, { force: true });
        rmSync(`${path}${NOTICE_SUFFIX}`, { force: true });
      }
    }
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch {
    // fail open: a budget hook must never block or trap an agent
  }
}
