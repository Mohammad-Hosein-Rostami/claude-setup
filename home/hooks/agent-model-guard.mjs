// PreToolUse(Agent|Task) guard. Model routing: an Agent call with no `model` runs on the lead's own model and spends it silently, so a
// call to a built-in type that pins no model (general-purpose, no subagent_type, Explore and the other built-ins) gets `sonnet` and a
// Plan call gets `opus`. Forks (subagent_type "fork"), plugin agents, an explicit model and unreadable input are not routed.
// Pin floor (lib/agent-pins.mjs): the agent file Claude Code loads sets a floor for its own model and effort, so a lower per-call
// value is left out (haiku < sonnet < opus; low < ... < max); this is how each agent keeps the pin of the plan (lex, dev, dev-ui,
// dev-pixel, dev-debug, tess-review on Opus; lex-web, pixel-qa, tess on Sonnet; lex-scout, dev-run on Haiku: the frontmatter of
// home/agents/<name>.md). A failure there leaves the input as it is (stderr line). A rewrite is allow + the full updatedInput.
// Gates, in order (the first deny wins; each deny-once gate lets the identical call through when it is sent again):
//   0. No Fable (owner rule: Fable is chosen by hand only, never for an agent): a call whose `model` is Fable (the alias or any id),
//      or with no `model` and an agent file that pins Fable, is denied every time with a one-line reason (fableReason).
//   1. Copy-branch brief (lib/copy-branch-brief.mjs): a writer brief that creates `<lane>-2` instead of continuing `<lane>` (deny once).
//   2. UI brief (lib/ui-brief-gate.mjs): a dev-pixel or pixel-qa brief that names no usable coverage matrix (`MATRIX: <path>`, or
//      `MATRIX: none: <reason>`) gets the ui-coverage init advice (deny once).
//   3. Main-agent cap (agent-budget.mjs claimMainSlot): at most MAX_MAIN_AGENTS agents launched from the main session run at once;
//      denied every time while full, and when the record cannot be read (fail closed). A call from inside a subagent (a helper) is
//      never capped. A launch a later gate denies gives its slot back (releaseMainSlot).
//   4. Writer isolation (lib/writer-agents.mjs, lib/agent-launches.mjs): a writer launched while another plain writer of this session
//      runs must be isolated (`isolation: "worktree"`, or a `worktree: <abs path>` brief field naming a linked worktree no open writer
//      holds) or read-only (a line starting `read-only:` or `scratchpad-only:`), else it is denied once with advice; a brief naming
//      more than one worktree is denied once too. Who writes: lib/agent-roles.mjs isWriterRole (dev, dev-ui, dev-pixel, dev-debug;
//      never lex or the read-only agents; other types by their agent file). A record that cannot be read denies (fail closed).
// Exports: guardedAgentInput (pure), fableReason, writerIsolationDeny, copyBranchBriefDeny.
// Invariants: the routing never blocks; each deny-once gate denies an identical call at most once per session.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { claimMainSlot, mainCapReason, releaseMainSlot } from './agent-budget.mjs';
import { quotedValue } from './lib/agent-brief.mjs';
import { isWriterRole } from './lib/agent-roles.mjs';
import { copyBranchBriefAdvice } from './lib/copy-branch-brief.mjs';
import { recordAgentLaunch } from './lib/agent-launches.mjs';
import { isSessionId } from './lib/session-store.mjs';
import { uiBriefDeny } from './lib/ui-brief-gate.mjs';
import { isReadOnlyBrief, laneWorktreeOf, worktreeLineAdvice } from './lib/writer-agents.mjs';

const FORK_TYPE = 'fork';
const DEFAULT_MODEL = 'sonnet';
const PLAN_MODEL = 'opus';
// Built-in agent types that pin no model; an omitted subagent_type means general-purpose.
const UNPINNED_BUILTIN_TYPES = ['general-purpose', 'Explore', 'claude', 'claude-code-guide', 'statusline-setup'];
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
  + 'running writer. Roles: `dev`, `dev-ui`, `dev-pixel` and `dev-debug` write; a reading job goes to `lex-scout`, `dev-run`, `tess` or `tess-review` '
  + '(or starts `read-only:`).';
const MANY_WORKTREES_ADVICE = 'A writer works in one lane worktree, and this brief names more than one, so none was taken: name one worktree, '
  + 'this writer\'s own, in its `worktree:` field.';
const NO_LANE = { folder: null, many: false }; // no worktree field is read (isolation "worktree", a read-only brief or no writer)
const ADVICE_STATES = ['running', 'held']; // recordAgentLaunch answers that get the deny-once advice (nothing was recorded)
const MANY_WORKTREES_STATE = 'many worktrees';

/** The fail-closed deny when the launch record cannot be read or stays locked; '' for any other state. */
function unusableRecordDeny({ state, storePath }) {
  return state === 'unusable' ? denyOutput(`writer gate: the launch record ${storePath} cannot be read or stays locked; fix or delete it, then launch again`) : '';
}

/**
 * The writer isolation gate (see the header). Records the launch of every agent it lets start, with the `isolated` and `readOnly`
 * flags of a writer, so the next launch sees it.
 * @param {unknown} input the hook input: tool_input {subagent_type, isolation, prompt}, cwd, session_id
 * @param {Record<string, string | undefined>} env process environment (HOME for the stores and agent files, CLAUDE_PROJECT_DIR)
 * @returns {Promise<string>} the deny JSON line when the record is unusable (every time), or on the first send of a plain writer while
 *   another plain writer runs, of a writer whose lane worktree an open record holds (it then runs as a plain writer), or of a writer
 *   whose brief names more than one worktree; '' otherwise, on the identical retry, for an input with no usable session id, on any failure
 */
export async function writerIsolationDeny(input, env = process.env) {
  try {
    const { subagent_type: type, isolation, prompt } = input?.tool_input ?? {};
    const session = input.session_id;
    if (!isSessionId(session)) return '';
    const writer = isWriterRole(type, env);
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const readOnly = writer && isReadOnlyBrief(prompt); // never bounces, so it claims no lane worktree (and holds none, `held`)
    const lane = writer && !readOnly && isolation !== WORKTREE_ISOLATION ? laneWorktreeOf(prompt, cwd, env) : NO_LANE;
    const laneWorktree = lane.folder;
    const isolated = writer && (isolation === WORKTREE_ISOLATION || laneWorktree !== null);
    const about = { cwd: laneWorktree ?? input.cwd, description: input.tool_input?.description, prompt }; // the open launch record
    const record = (options) => recordAgentLaunch(session, type, env, { writer, readOnly, about, ...options });
    // a brief naming several worktrees is refused before anything is recorded: which folder it works in is unknown, so it holds none
    const counted = lane.many ? { state: MANY_WORKTREES_STATE } : record({ isolated, unlessRunning: writer && !isolated && !readOnly, worktree: laneWorktree });
    if (![...ADVICE_STATES, MANY_WORKTREES_STATE].includes(counted.state)) return unusableRecordDeny(counted);
    const lead = lane.many ? MANY_WORKTREES_ADVICE : PARALLEL_WRITER_ADVICE;
    const { adviceOnce } = await import('./lib/bounce-once.mjs');
    const call = { command: `${type}: isolation ${String(isolation)}: ${String(prompt)}`, cwd, input, hook: 'agent-model-guard', tool: 'Agent' };
    const logged = { type, class: lane.many ? 'writer naming many worktrees' : 'parallel writer without isolation' };
    if (adviceOnce([lead], { ...call, logged }, env) !== '') return denyOutput([`Not started: ${lead}`, worktreeLineAdvice(prompt, env), SEND_AGAIN]
      .filter(Boolean).join('\n')); // the middle line quotes the brief's near-miss line or its worktrees ('' when the brief has none)
    return unusableRecordDeny(record({ isolated: isolated && counted.state !== 'held' })); // the identical retry runs
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

const FABLE_MODEL = /fable/i; // the alias `fable` and every Fable model id
const FABLE_RULE = 'Not started: Fable is never used for an agent (the owner chooses it by hand only)';

/**
 * The no-Fable gate (see the header): the model the agent would run on is the call's `model` when set (it outranks the agent file),
 * else the agent file's pin (lib/agent-pins.mjs readPin, the file Claude Code loads).
 * @param {unknown} input the hook input: tool_input {subagent_type, model}, cwd
 * @param {Record<string, string | undefined>} env HOME / CLAUDE_CONFIG_DIR (where the agent files are)
 * @returns {Promise<string>} the one-line deny reason, or '' when the agent runs on another model; a pin that cannot be read is
 *   reported on stderr and lets the call run (the pin floor reports the same file)
 */
export async function fableReason(input, env = process.env) {
  const { subagent_type: type, model } = input?.tool_input ?? {};
  if (typeof model === 'string' && model !== '') {
    return FABLE_MODEL.test(model) ? `${FABLE_RULE}: leave \`model\` out of the Agent call (it was \`${quotedValue(model)}\`).` : '';
  }
  try {
    const { readPin } = await import('./lib/agent-pins.mjs');
    const pin = readPin(type, typeof input?.cwd === 'string' ? input.cwd : process.cwd(), env);
    return typeof pin?.model === 'string' && FABLE_MODEL.test(pin.model)
      ? `${FABLE_RULE}: the \`${quotedValue(String(type))}\` agent file pins \`${quotedValue(pin.model)}\`; change its \`model\` line, and leave \`model\` out of the Agent call.`
      : '';
  } catch (error) {
    process.stderr.write(`agent-model-guard: fable check skipped: ${error.message}\n`);
    return '';
  }
}

/** The deny line of the gates (header order), or '' when the call may run; a denied launch gives its main-agent slot back. */
async function gatesDeny(input) {
  const fable = await fableReason(input);
  if (fable !== '') return denyOutput(fable);
  const early = (await copyBranchBriefDeny(input)) || (await uiBriefDeny(input));
  if (early !== '') return early;
  const slot = claimMainSlot(input);
  const capped = mainCapReason(slot);
  if (capped !== '') return denyOutput(capped);
  const writerDeny = await writerIsolationDeny(input);
  if (writerDeny !== '' && slot.key) releaseMainSlot(input.session_id, slot.key);
  return writerDeny;
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
  const deny = await gatesDeny(input);
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
  if (!floored) return;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: floored } }));
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`agent-model-guard: ${error.message}\n`);
  }
}
