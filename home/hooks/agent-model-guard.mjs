// PreToolUse(Agent|Task) guard: an Agent call with no `model` runs on the lead's own model (Opus / Fable) and spends it silently. A
// call to a built-in type that pins no model (general-purpose, no subagent_type, Explore and the other built-ins) gets `sonnet`; a Plan
// call without one gets `opus`. Forks (subagent_type "fork", they inherit the lead on purpose), plugin agents, an explicit model and
// unreadable input are not routed. Pin floor (lib/agent-pins.mjs): the agent file Claude Code loads (found by its `name`, deepest project
// folder first) sets a floor, as a per-call value outranks the file; a file with no `model` or `effort` line is floored at
// CLAUDE_CODE_SUBAGENT_MODEL (settings/base.json: claude-sonnet-5-5) or CLAUDE_CODE_SUBAGENT_EFFORT, the defaults the CLI gives it. A
// lower call value (haiku < sonnet < opus, by version in a family; low < ... < max) is left out so the floor applies; an equal, higher
// or unknown value passes, none is added; a failure there leaves the input as is (stderr line). A rewrite: allow + the full updatedInput.
// UI brief gate (lib/ui-brief-gate.mjs uiBriefDeny): a `ui-implementer` or `visual-qa` brief that names no usable coverage matrix
// (`MATRIX: <path>`, or `MATRIX: none: <reason>` for a change with no visual part) is denied once with the ui-coverage init advice.
// Brief lines (lib/agent-brief.mjs), after the gate and on top of the routing: a line naming the project's STATUS.md goes before a brief
// whose project has `## Standing rules`, and an architect or Plan spec brief gets the Reuse inventory / Contract facts line after it (an
// analysis brief, whose first non-empty line starts `analysis:`, does not). Fixed text plus a path only; any failure leaves the brief as it is.
// Agent cap (plan "no workflows" C7): every Agent or Task call that passes the deny-once gates below is recorded (lib/agent-launches.mjs),
// and while MAX_RUNNING_AGENTS (5) agents of any kind run in this session the call is denied every time, also when sent again (the
// owner's hard cap, an exception to deny-once). A launch record that cannot be read or stays locked denies too, naming the file (fail
// closed); a call with no usable session id is not recorded. Whether this hook fires for an Agent call inside a subagent is probe U6 (not
// run): until then such a launch may go uncounted, and the env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS (the same number) is the backstop.
// Writer isolation gate (after the UI gate): a writing agent (lib/writer-agents.mjs isWritingAgent: implementer, ui-implementer,
// general-purpose, claude, or an agent file whose tools include Write/Edit; scout, runner, Explore, Plan and architect never) launched
// while another plain writer of this session runs must be isolated or read-only, else it is denied once with advice naming the roles,
// the isolation forms and the brief line meant to name a worktree (worktreeLineAdvice); the identical call sent again runs. Isolated
// (recorded `isolated`; the open record's cwd is the lane worktree): `isolation: "worktree"`, or a `worktree: <abs path>` field
// (own line, list item or after `·`, `|`, `;`, `,`), in the prompt or a brief file it names, of a linked worktree git lists that is not
// the lead's folder (laneWorktreeOf: a git that fails or hangs is no isolation) and that no open writer record of the session holds as
// its cwd (else `held`: denied once, and the retry runs as a plain writer). A `,` or `;` separates fields only in a header line of
// `KEY: value` fields ("Lane A landed, worktree: /a" is prose), and a quoted value is read whole. A brief with more than one distinct
// `worktree:` value is never isolated by any of them: it is denied once naming them, whether or not another writer runs, and the retry runs
// as a plain writer. Read-only (recorded
// `readOnly`, held at the stop by commit-gate.mjs): a line starting `read-only:` or `scratchpad-only:` (isReadOnlyBrief). Neither makes a
// later writer bounce ("plain" = neither); the gate is deny-once, and an isolated agent can still write the main checkout by shell
// (worktrees.md:104-112). "Still runs" = the session's own record: every launch this hook lets start, started on SubagentStart and ended
// on SubagentStop by agent-budget.mjs; a launch that never started or an agent idle for 30 min stops counting (lib/agent-launches.mjs).
// Copy-branch brief gate (run first, round 4): a writer brief that creates a copy of an existing branch (`<lane>-2`) instead of continuing the
// lane's own (lib/copy-branch-brief.mjs) is sent back once (deny-once, own digest, class "copy branch brief"). No workflow spawn fires it (P2).
// Exports: guardedAgentInput (pure), writerIsolationDeny (the writer isolation gate and the agent cap) and copyBranchBriefDeny (the gates).
// Invariants: the routing never blocks or denies; each gate denies an identical call at most once per session.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { quotedValue, withBriefLines } from './lib/agent-brief.mjs';
import { copyBranchBriefAdvice } from './lib/copy-branch-brief.mjs';
import { MAX_RUNNING_AGENTS, recordAgentLaunch } from './lib/agent-launches.mjs';
import { isSessionId } from './lib/session-store.mjs';
import { uiBriefDeny } from './lib/ui-brief-gate.mjs';
import { isReadOnlyBrief, isWritingAgent, laneWorktreeOf, worktreeLineAdvice } from './lib/writer-agents.mjs';

const FORK_TYPE = 'fork';
const DEFAULT_MODEL = 'sonnet';
const PLAN_MODEL = 'opus';
// Built-in agent types that pin no model; an omitted subagent_type means general-purpose.
const UNPINNED_BUILTIN_TYPES = ['general-purpose', 'Explore', 'claude', 'claude-code-guide', 'statusline-setup'];
const AGENT_ID_CHARS = 8; // how much of an agent id the cap text shows
const SEND_AGAIN = 'Send the same call again unchanged and it runs.';

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

const denyOutput = (reason) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`;

const WORKTREE_ISOLATION = 'worktree';
const PARALLEL_WRITER_ADVICE = 'Another writing agent of this session is still running in the shared folder: give this one `isolation: "worktree"`, '
  + 'or make its worktree first (`git worktree add -b <branch> <path> <base>`) and add the brief line `worktree: <absolute path>`, or wait for the '
  + 'running writer. Roles: `implementer` or `ui-implementer` writes; a reading job goes to `scout`, `runner` or `reviewer` (or starts `read-only:`).';
const MANY_WORKTREES_ADVICE = 'A writer works in one lane worktree, and this brief names more than one, so none was taken: name one worktree, '
  + 'this writer\'s own, in its `worktree:` field.';
const NO_LANE = { folder: null, many: false }; // no worktree field is read (isolation "worktree", a read-only brief or no writer)
const ADVICE_STATES = ['running', 'held']; // recordAgentLaunch answers that get the deny-once advice (nothing was recorded)
const MANY_WORKTREES_STATE = 'many worktrees';

/**
 * The deny for a launch the record refused: the cap text with the running agents, or the fail-closed text naming the record.
 * @param {{state: string, running: Array<{type: string, agent?: string}>, storePath: string}} result recordAgentLaunch's answer
 * @returns {string} the deny JSON line for `full` and `unusable`; '' for any other state
 */
function launchRefusal({ state, running, storePath }) {
  if (state === 'unusable') return denyOutput(`agent cap: the launch record ${storePath} cannot be read or stays locked; fix or delete it, then launch again`);
  if (state !== 'full') return '';
  const listed = running.map(({ type, agent }) => `${quotedValue(type)} ${agent === undefined ? 'pending' : quotedValue(agent.slice(0, AGENT_ID_CHARS))}`);
  return denyOutput(`agent cap: ${MAX_RUNNING_AGENTS} agents of this session run (${listed.join(', ')}); wait for one to return (store: ${storePath})`);
}

/**
 * The writer isolation gate and the agent cap (see the header). Records the launch of every agent it lets start, with the `isolated`
 * and `readOnly` flags of a writer, so the next launch sees it.
 * @param {unknown} input the hook input: tool_input {subagent_type, isolation, prompt}, cwd, session_id
 * @param {Record<string, string | undefined>} env process environment (HOME for the stores and agent files, CLAUDE_PROJECT_DIR)
 * @returns {Promise<string>} the deny JSON line when the cap is full or the record is unusable (every time), or on the first send of a
 *   plain writer (no isolation, no read-only brief) while another plain writer runs, or of a writer whose lane worktree an open record
 *   holds (it then runs as a plain writer), or of a writer whose brief names more than one worktree (whatever else runs); '' otherwise, on the identical retry, for an input with no usable session id, on any failure
 */
export async function writerIsolationDeny(input, env = process.env) {
  try {
    const { subagent_type: type, isolation, prompt } = input?.tool_input ?? {};
    const session = input.session_id;
    if (!isSessionId(session)) return '';
    const writer = isWritingAgent(type, env);
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const readOnly = writer && isReadOnlyBrief(prompt); // never bounces, so it claims no lane worktree (and holds none, `held`)
    const lane = writer && !readOnly && isolation !== WORKTREE_ISOLATION ? laneWorktreeOf(prompt, cwd, env) : NO_LANE;
    const laneWorktree = lane.folder;
    const isolated = writer && (isolation === WORKTREE_ISOLATION || laneWorktree !== null);
    const about = { cwd: laneWorktree ?? input.cwd, description: input.tool_input?.description, prompt }; // the open launch record (r9-resume)
    const record = (options) => recordAgentLaunch(session, type, env, { writer, readOnly, about, cap: MAX_RUNNING_AGENTS, ...options });
    // a brief naming several worktrees is refused before anything is recorded: which folder it works in is unknown, so it holds none
    const counted = lane.many ? { state: MANY_WORKTREES_STATE } : record({ isolated, unlessRunning: writer && !isolated && !readOnly, worktree: laneWorktree });
    if (![...ADVICE_STATES, MANY_WORKTREES_STATE].includes(counted.state)) return launchRefusal(counted);
    const lead = lane.many ? MANY_WORKTREES_ADVICE : PARALLEL_WRITER_ADVICE;
    const { adviceOnce } = await import('./lib/bounce-once.mjs');
    const call = { command: `${type}: isolation ${String(isolation)}: ${String(prompt)}`, cwd, input, hook: 'agent-model-guard', tool: 'Agent' };
    const logged = { type, class: lane.many ? 'writer naming many worktrees' : 'parallel writer without isolation' };
    if (adviceOnce([lead], { ...call, logged }, env) !== '') return denyOutput([`Not started: ${lead}`, worktreeLineAdvice(prompt, env), SEND_AGAIN]
      .filter(Boolean).join('\n')); // the middle line quotes the brief's near-miss line or its worktrees ('' when the brief has none)
    return launchRefusal(record({ isolated: isolated && counted.state !== 'held' })); // the identical retry runs, unless the cap filled
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
  let floored = routed; // the pin floor fails open: a load or read error in lib/agent-pins.mjs leaves the input as it is
  try {
    const { flooredAgentInput } = await import('./lib/agent-pins.mjs');
    floored = flooredAgentInput(routed ?? input?.tool_input, typeof input?.cwd === 'string' ? input.cwd : process.cwd()) ?? routed;
  } catch (error) {
    process.stderr.write(`agent-model-guard: pin floor skipped: ${error.message}\n`);
  }
  const updatedInput = withBriefLines(floored ?? input?.tool_input, input?.cwd) ?? floored; // the brief lines on top of the model, if any
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
