// PreToolUse(Agent|Task) guard: an Agent call with no `model` would inherit the lead model (Opus / Fable) and spend it
// silently. An unpinned call to a built-in type that pins no model itself (general-purpose, a call with no subagent_type,
// Explore and the other built-ins) gets `sonnet`; a Plan call without one gets `opus`. The mode plays no part: every mode
// is as accurate as the high ones. Forks (subagent_type "fork", they inherit the lead on purpose), the repo's own agents (their files
// pin a model; a per-call model would override it), plugin agents, an explicit model, and unreadable input pass
// through untouched: no output, exit 0.
// Env interaction: settings/base.json sets CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5-5. See docs/catalog.md for how
// Claude Code ranks that variable against the per-call `model` this hook sets.
// Output when it rewrites: {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput}}.
// `updatedInput` replaces the whole input object (per the hooks docs), so the full original input is returned.
// UI brief gate: denies once with advice for UI briefs. A `ui-implementer` or `visual-qa` call is quiet when its prompt has a line that
// starts (after optional blanks) with `MATRIX: <path>` naming a coverage matrix (a JSON object with a `surfaces` array; a relative path
// starts at the call's cwd, `~` is the home folder) or with `MATRIX: none: <reason>` (15+ characters). Otherwise it is denied once with
// the ui-coverage init advice and the identical call sent again runs: lib/bounce-once.mjs adviceOnce keeps the digest of cwd, type and
// prompt in this session's store and logs "advice", "advice-retry" or "advice-unrecorded" with the subagent type, the digest and a fixed
// reason class only (no prompt text). The MATRIX lines are checked in order, at most MAX_MATRIX_LINES, and the first usable one ends the
// check. A quality hint, not a safety rule: never the owner, and any failure lets the call run. The path comes from the prompt, so it is
// untrusted: it is stat-ed and read only as a regular
// file of at most MAX_MATRIX_BYTES, never run, its content never printed, and a UNC or device path (two leading slashes or backslashes)
// is never looked up; the deny text quotes it without control characters, cut short.
// Only these two types load the Bash guard's modules, so the routing never depends on them.
// Brief lines (lib/agent-brief.mjs), after the gate and on top of the routing: a line naming the project's STATUS.md goes before a brief
// whose project has `## Standing rules`, and an architect or Plan brief gets the Reuse inventory / Contract facts line after it. Fixed
// text plus a path only; any failure leaves the brief as it is.
// Exports: guardedAgentInput (pure), matrixLines (pure), uiBriefDeny (the gate), MAX_MATRIX_BYTES. Invariants: the routing never blocks
// or denies; the gate denies an identical call at most once per session.
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UNPRINTABLE, readFileHead, withBriefLines } from './lib/agent-brief.mjs';

const FORK_TYPE = 'fork';
const DEFAULT_MODEL = 'sonnet';
const PLAN_MODEL = 'opus';
// Built-in agent types that pin no model; an omitted subagent_type means general-purpose.
const UNPINNED_BUILTIN_TYPES = ['general-purpose', 'Explore', 'claude', 'claude-code-guide', 'statusline-setup'];

const UI_AGENT_TYPES = ['ui-implementer', 'visual-qa'];
// A line that starts with `MATRIX:` after optional blanks. Lines end at \n; a CRLF line's \r is left out of the value.
const MATRIX_LINE = /(?:^|\n)[ \t]*MATRIX:([^\r\n]*)/g;
const MAX_MATRIX_LINES = 5; // a brief names one matrix; the cap bounds the files read for one call
const NONE_PREFIX = 'none:';
const MIN_REASON_CHARS = 15; // what ui-coverage asks of every reason
const MAX_PATH_CHARS = 4096; // PATH_MAX on Linux: a longer value is not looked up
export const MAX_MATRIX_BYTES = 2 * 1024 * 1024; // 2 MB: far above a real matrix (a few KB); bounds the memory and time of one read
const MAX_QUOTED_CHARS = 200; // how much of a named path the deny text quotes
const HOME_PREFIX = /^~(?=$|[\\/])/; // `~` and `~/...`; `~user` is left as it is
// A UNC or device path (\\host\share, //host/share, \\.\pipe\x): on Windows a lookup reaches the network (and may send the user's
// NTLM credentials) or a pipe, so a value written like that is never looked up
const NETWORK_PATH = /^[\\/]{2}/;
const NOT_STARTED = 'Not started: the UI brief names no coverage matrix (the owner was not asked).';
const INIT_ADVICE = 'Before the first UI lane run `node ~/.claude/tools/ui-coverage/ui-coverage.mjs init <matrix.json> --locales .. --widths .. '
  + '--surfaces .. [--frames frames.json]` and add the line `MATRIX: <path>` (or `MATRIX: none: <reason>` for a one-file tweak with no Figma).';
const SEND_AGAIN = 'Send the same call again unchanged and it runs.';
const SHORT_REASON = `\`MATRIX: none:\` needs a reason of ${MIN_REASON_CHARS} or more characters.`;
// The log names the problems by these fixed classes, never by prompt text
const NO_MATRIX_LINE = 'no MATRIX line';
const problemClass = (problem) => (problem === SHORT_REASON ? 'short none reason' : 'not a matrix');

/**
 * The Agent input with the model this call needs when it names none (the same in every mode).
 * @param {unknown} toolInput - `tool_input` of the Agent / Task call.
 * @returns {object | null} a copy of the input with `model` added, or null when nothing is to change.
 */
export function guardedAgentInput(toolInput) {
  if (toolInput === null || typeof toolInput !== 'object') return null;
  if (toolInput.model !== undefined && toolInput.model !== '') return null;
  const type = toolInput.subagent_type;
  if (type === FORK_TYPE) return null;
  if (type === 'Plan') return { ...toolInput, model: PLAN_MODEL };
  const unpinned = type === undefined || type === '' || UNPINNED_BUILTIN_TYPES.includes(type);
  return unpinned ? { ...toolInput, model: DEFAULT_MODEL } : null;
}

/**
 * The values of a prompt's MATRIX lines. Only a line that starts with `MATRIX:` after optional blanks counts (a line inside a code
 * fence too); `MATRIX:` later in a line never does.
 * @param {string} prompt the Agent call's prompt
 * @returns {string[]} the text after each `MATRIX:`, trimmed, empty ones left out; at most MAX_MATRIX_LINES
 */
export function matrixLines(prompt) {
  const values = [];
  for (const [, text] of prompt.matchAll(MATRIX_LINE)) {
    const value = text.trim();
    if (value !== '') values.push(value);
    if (values.length === MAX_MATRIX_LINES) break;
  }
  return values;
}

/** @returns {string} value without control, format and separator characters, cut to MAX_QUOTED_CHARS (then "...") */
function quoted(value) {
  const printable = value.slice(0, MAX_PATH_CHARS).replace(UNPRINTABLE, '');
  return printable.length > MAX_QUOTED_CHARS ? `${printable.slice(0, MAX_QUOTED_CHARS)}...` : printable;
}

/** @returns {boolean} true when path is a regular file of at most MAX_MATRIX_BYTES holding a JSON object with a `surfaces` array */
function isMatrixFile(path) {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_MATRIX_BYTES) return false; // a folder, FIFO, device or bigger file is never opened
    const text = readFileHead(path, MAX_MATRIX_BYTES);
    return text !== undefined && Array.isArray(JSON.parse(text)?.surfaces); // of all JSON values only an object has a `surfaces` key
  } catch {
    return false; // missing, unreadable or not JSON: not a matrix
  }
}

/** @returns {string | undefined} undefined for a usable matrix or a long enough `none:` reason, else the advice line naming the problem */
function matrixProblem(value, cwd, env) {
  if (value.startsWith(NONE_PREFIX)) return value.slice(NONE_PREFIX.length).trim().length >= MIN_REASON_CHARS ? undefined : SHORT_REASON;
  const path = resolve(cwd, value.replace(HOME_PREFIX, () => env.HOME || env.USERPROFILE || homedir()));
  const usable = value.length <= MAX_PATH_CHARS && !NETWORK_PATH.test(value) && isMatrixFile(path);
  return usable ? undefined : `\`${quoted(value)}\` does not exist or is not a matrix.`;
}

const denyOutput = (reason) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`;

/**
 * The UI brief gate (see the header): the deny for a ui-implementer or visual-qa call whose prompt names no usable coverage matrix,
 * given once per identical call.
 * @param {unknown} input the hook input: tool_input {subagent_type, prompt}, cwd (else this process's folder), session_id
 * @param {Record<string, string | undefined>} env process environment (HOME for `~` and the store, CLAUDE_GUARD_LOG)
 * @returns {Promise<string>} the deny JSON line on the first send; '' when the gate is quiet, on the identical retry, when the send
 *   cannot be recorded, and on any failure
 */
export async function uiBriefDeny(input, env = process.env) {
  try {
    const { subagent_type: type, prompt } = input?.tool_input ?? {};
    if (!UI_AGENT_TYPES.includes(type) || typeof prompt !== 'string') return '';
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const problems = [];
    for (const value of matrixLines(prompt)) {
      const problem = matrixProblem(value, cwd, env);
      if (problem === undefined) return ''; // one usable MATRIX line is enough: the files named after it are never read
      problems.push(problem);
    }
    const advice = [...new Set(problems), INIT_ADVICE];
    const logged = { type, class: problems.length === 0 ? NO_MATRIX_LINE : [...new Set(problems.map(problemClass))].join(', ') };
    const { adviceOnce } = await import('./lib/bounce-once.mjs');
    // adviceOnce stores the digest (the identical retry runs) and logs the send as `logged`; its deny text is worded for Bash, so the gate
    // words its own
    const recorded = adviceOnce(advice, { command: `${type}: ${prompt}`, cwd, input, hook: 'agent-model-guard', tool: 'Agent', logged }, env);
    return recorded === '' ? '' : denyOutput([NOT_STARTED, ...advice.map((line) => `- ${line}`), SEND_AGAIN].join('\n'));
  } catch {
    return ''; // a quality hint, not a safety rule: any failure lets the call run
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8')); // decoded once: a character split across chunks stays whole
  } catch {
    return; // not hook JSON: stay silent, never block
  }
  const deny = await uiBriefDeny(input);
  if (deny !== '') {
    process.stdout.write(deny);
    return;
  }
  const routed = guardedAgentInput(input?.tool_input);
  const updatedInput = withBriefLines(routed ?? input?.tool_input, input?.cwd) ?? routed; // the brief lines on top of the model, if any
  if (!updatedInput) return;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } }));
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`agent-model-guard: ${error.message}\n`);
  }
}
