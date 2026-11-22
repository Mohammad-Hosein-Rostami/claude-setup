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
// starts at the call's cwd, `~` is the home folder) or with `MATRIX: none: <reason>` (15+ characters, and only when the brief outside its
// MATRIX lines names no Figma, frame, baseline or design export: such a brief needs a matrix, G7). Otherwise it is denied once with
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
// Agent cap (plan "no workflows" C7): every Agent or Task call that passes the deny-once gates below is recorded (lib/agent-launches.mjs),
// and while MAX_RUNNING_AGENTS (5) agents of any kind run in this session the call is denied every time, also when sent again (the
// owner's hard cap, an exception to deny-once). A launch record that cannot be read or stays locked denies too, naming the file (fail
// closed); a call with no usable session id is not recorded. Whether this hook fires for an Agent call inside a subagent is probe U6 (not
// run): until then such a launch may go uncounted, and the env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS (the same number) is the backstop.
// Writer isolation gate (after the UI gate): a writing agent (lib/writer-agents.mjs isWritingAgent: implementer, ui-implementer,
// test-writer, general-purpose, claude, or an agent file whose tools include Write/Edit; scout, runner, reviewer, security-auditor, Explore,
// Plan and architect never) launched while another plain writing agent of this session still runs must carry `isolation: "worktree"` or a
// read-only brief, else it is denied once with that advice (adviceOnce, as the UI gate) and the identical call sent again runs. A launch
// with `isolation: "worktree"` runs and is recorded `isolated`; one whose prompt has a line starting `read-only:` or `scratchpad-only:`
// (isReadOnlyBrief) runs and is recorded `readOnly`; neither kind makes a later writer bounce ("plain" = neither flag). The read-only brief
// is held at the agent's stop by commit-gate.mjs. Why the relaxation lets nothing new through: the gate is deny-once and the identical
// retry runs, and an isolated agent can still write the main checkout by shell (worktrees.md:104-112), so counting it was no protection.
// "Still runs" comes from the session's own record: every writer launch this hook lets start, marked started on SubagentStart and ended
// on SubagentStop by agent-budget.mjs; a launch that never started or an agent idle for 30 min stops counting (lib/agent-launches.mjs).
// Copy-branch brief gate (run first, round 4): a writer brief that creates a copy of an existing branch (`<lane>-2`) instead of continuing the
// lane's own (lib/copy-branch-brief.mjs) is sent back once with the same-branch steps. Same deny-once mechanics as the gates above, with its own
// digest (logged class "copy branch brief"). A workflow spawn does not fire this hook (probe P2). There is no gate that sends a plain Agent call
// to a workflow: the lead picks inline, one agent or a workflow by the job (home/CLAUDE.md, "Inline, agent or workflow").
// Exports: guardedAgentInput (pure), matrixLines (pure), namesDesignSource (pure), uiBriefDeny, writerIsolationDeny (the writer isolation gate and the agent cap) and copyBranchBriefDeny (the gates), MAX_MATRIX_BYTES.
// Invariants: the routing never blocks or denies; each gate denies an identical call at most once per session.
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UNPRINTABLE, readFileHead, withBriefLines } from './lib/agent-brief.mjs';
import { copyBranchBriefAdvice } from './lib/copy-branch-brief.mjs';
import { MAX_RUNNING_AGENTS, recordAgentLaunch } from './lib/agent-launches.mjs';
import { isSessionId } from './lib/session-store.mjs';
import { isReadOnlyBrief, isWritingAgent } from './lib/writer-agents.mjs';

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
const AGENT_ID_CHARS = 8; // how much of an agent id the cap text shows
const HOME_PREFIX = /^~(?=$|[\\/])/; // `~` and `~/...`; `~user` is left as it is
// A UNC or device path (\\host\share, //host/share, \\.\pipe\x): on Windows a lookup reaches the network (and may send the user's
// NTLM credentials) or a pipe, so a value written like that is never looked up
const NETWORK_PATH = /^[\\/]{2}/;
const NOT_STARTED = 'Not started: the UI brief names no coverage matrix (the owner was not asked).';
const INIT_ADVICE = 'Before the first UI lane run `node ~/.claude/tools/ui-coverage/ui-coverage.mjs init <matrix.json> --locales .. --widths .. '
  + '--surfaces .. [--frames frames.json]` and add the line `MATRIX: <path>` (or `MATRIX: none: <reason>` for a one-file tweak with no Figma).';
const SEND_AGAIN = 'Send the same call again unchanged and it runs.';
const SHORT_REASON = `\`MATRIX: none:\` needs a reason of ${MIN_REASON_CHARS} or more characters.`;
const NONE_WITH_DESIGN = '`MATRIX: none:` is for a one-file tweak with no Figma: this brief names Figma, a frame, a baseline or an export, '
  + 'so it needs a coverage matrix.';
// What makes a brief design work (G7). "export" counts unless it is the JS keyword (`export default`, `export const`, `export {`).
const DESIGN_SOURCE = /figma|فیگما|\bframes?\b|\bbaselines?\b|\bexport(?:s|ed)?\b(?!\s+(?:default|const|let|var|function|async|class|type|interface|enum|\{|\*))/i;
// The log names the problems by these fixed classes, never by prompt text
const NO_MATRIX_LINE = 'no MATRIX line';
const PROBLEM_CLASSES = new Map([[SHORT_REASON, 'short none reason'], [NONE_WITH_DESIGN, 'none with a design source']]);
const problemClass = (problem) => PROBLEM_CLASSES.get(problem) ?? 'not a matrix';

/**
 * Whether the brief, outside its MATRIX lines (a `none:` reason such as "no Figma frame" says what is absent), names a design source.
 * @param {string} prompt the Agent call's prompt
 * @returns {boolean} true when it names Figma, a frame, a baseline or an export
 */
export function namesDesignSource(prompt) {
  return DESIGN_SOURCE.test(prompt.replace(MATRIX_LINE, '\n'));
}

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

/**
 * @param {boolean} designBrief the brief names a design source (namesDesignSource), so `none:` is refused
 * @returns {string | undefined} undefined for a usable matrix or an allowed `none:` reason, else the advice line naming the problem
 */
function matrixProblem(value, cwd, env, designBrief) {
  if (value.startsWith(NONE_PREFIX)) {
    if (value.slice(NONE_PREFIX.length).trim().length < MIN_REASON_CHARS) return SHORT_REASON;
    return designBrief ? NONE_WITH_DESIGN : undefined;
  }
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
    const designBrief = namesDesignSource(prompt);
    for (const value of matrixLines(prompt)) {
      const problem = matrixProblem(value, cwd, env, designBrief);
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

const WORKTREE_ISOLATION = 'worktree';
const PARALLEL_WRITER_ADVICE = 'Another writing agent of this session is still running in the shared folder: launch this one with '
  + '`isolation: "worktree"` (parallel writers each get their own worktree), or wait until the running writer has finished.';

/**
 * The deny for a launch the record refused: the cap text with the running agents, or the fail-closed text naming the record.
 * @param {{state: string, running: Array<{type: string, agent?: string}>, storePath: string}} result recordAgentLaunch's answer
 * @returns {string} the deny JSON line for `full` and `unusable`; '' for any other state
 */
function launchRefusal({ state, running, storePath }) {
  if (state === 'unusable') return denyOutput(`agent cap: the launch record ${storePath} cannot be read or stays locked; fix or delete it, then launch again`);
  if (state !== 'full') return '';
  const listed = running.map(({ type, agent }) => `${quoted(type)} ${agent === undefined ? 'pending' : quoted(agent.slice(0, AGENT_ID_CHARS))}`);
  return denyOutput(`agent cap: ${MAX_RUNNING_AGENTS} agents of this session run (${listed.join(', ')}); wait for one to return (store: ${storePath})`);
}

/**
 * The writer isolation gate and the agent cap (see the header). Records the launch of every agent it lets start, with the `isolated`
 * and `readOnly` flags of a writer, so the next launch sees it.
 * @param {unknown} input the hook input: tool_input {subagent_type, isolation, prompt}, cwd, session_id
 * @param {Record<string, string | undefined>} env process environment (HOME for the stores and agent files, CLAUDE_PROJECT_DIR)
 * @returns {Promise<string>} the deny JSON line when the cap is full or the record is unusable (every time), or on the first send of a
 *   plain writer (no isolation, no read-only brief) while another plain writer runs; '' otherwise, on the identical retry, for an input
 *   with no usable session id, and on any failure
 */
export async function writerIsolationDeny(input, env = process.env) {
  try {
    const { subagent_type: type, isolation, prompt } = input?.tool_input ?? {};
    const session = input.session_id;
    if (!isSessionId(session)) return '';
    const writer = isWritingAgent(type, env);
    const flags = { isolated: writer && isolation === WORKTREE_ISOLATION, readOnly: writer && isReadOnlyBrief(prompt) };
    const plain = writer && !flags.isolated && !flags.readOnly;
    const about = { cwd: input.cwd, description: input.tool_input?.description, prompt }; // the open launch record (r9-resume)
    const record = (unlessRunning) => recordAgentLaunch(session, type, env, { writer, unlessRunning, ...flags, about, cap: MAX_RUNNING_AGENTS });
    const counted = record(plain);
    if (counted.state !== 'running') return launchRefusal(counted);
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const { adviceOnce } = await import('./lib/bounce-once.mjs');
    const call = { command: `${type}: isolation ${String(isolation)}: ${String(prompt)}`, cwd, input, hook: 'agent-model-guard', tool: 'Agent' };
    const recorded = adviceOnce([PARALLEL_WRITER_ADVICE], { ...call, logged: { type, class: 'parallel writer without isolation' } }, env);
    if (recorded !== '') return denyOutput([`Not started: ${PARALLEL_WRITER_ADVICE}`, SEND_AGAIN].join('\n'));
    return launchRefusal(record(false)); // the identical retry runs: it is a running writer now, unless the cap filled meanwhile
  } catch {
    return ''; // a quality rule, not a safety rule: any failure lets the call run
  }
}

const COPY_BRANCH_CLASS = 'copy branch brief';

/**
 * The copy-branch brief gate (see the header): deny once per identical call; the identical call sent again passes.
 * @param {unknown} input the hook input: tool_input {subagent_type, prompt}, cwd, session_id
 * @param {Record<string, string | undefined>} env process environment (HOME, CLAUDE_GUARD_LOG)
 * @returns {Promise<string>} the deny JSON line, or '' when the brief is fine, on the identical retry and on any failure
 */
export async function copyBranchBriefDeny(input, env = process.env) {
  try {
    const verdict = copyBranchBriefAdvice(input, env);
    if (!verdict.deny) return '';
    const { subagent_type: type, prompt } = input?.tool_input ?? {};
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const { adviceOnce } = await import('./lib/bounce-once.mjs');
    const call = { command: `copy-branch brief: ${String(type)}: ${String(prompt)}`, cwd, input, hook: 'agent-model-guard', tool: 'Agent', logged: { type, class: COPY_BRANCH_CLASS } };
    if (adviceOnce([verdict.reason], call, env) !== '') return denyOutput([`Not started: ${verdict.reason}`, SEND_AGAIN].join('\n'));
    return '';
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
  const deny = (await copyBranchBriefDeny(input)) || (await uiBriefDeny(input)) || (await writerIsolationDeny(input));
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
