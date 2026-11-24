// PreToolUse(Agent|Task) guard. Model routing: an Agent call with no `model` runs on the lead's own model and spends it silently, so a
// call to a built-in type that pins no model (general-purpose, no subagent_type, Explore and the other built-ins) gets `sonnet` and a
// Plan call gets `opus` (types matched in any case: `explore`, `plan`). Forks (subagent_type "fork"), plugin agents and an explicit
// model are not routed. Input that is not a JSON object, and any crash of the guard, deny the call (the no-Fable gate fails closed).
// Pin floor (lib/agent-pins.mjs): the agent file Claude Code loads sets a floor for its own model and effort, so a lower per-call
// value is left out (haiku < sonnet < opus; low < ... < max); this is how each agent keeps the pin of the plan (lex, dev, dev-ui,
// dev-pixel, dev-debug, tess-review, tess-write on Opus; lex-web, pixel-qa, tess on Sonnet; lex-scout, dev-run on Haiku: the frontmatter of
// home/agents/<name>.md). A failure there leaves the input as it is (stderr line). A rewrite is allow + the full updatedInput.
// Gates, in order (the first deny wins; each deny-once gate lets the identical call through when it is sent again):
//   R. Main-agent route (agent-budget.mjs mainRouteReason): the main session starts only lex, dev and tess (and Claude Code's
//      claude-code-guide and statusline-setup); any other type from the main session is denied every time with the route to take.
//      A call from inside a subagent (`agent_id`) that starts lex, dev or tess is denied every time too: only the boss starts them,
//      and the agent asks for one with a `needs:` line; its other calls (its helpers) are not routed. First, so a wrong route spends
//      no deny-once gate.
//   0. No Fable (owner rule: Fable is chosen by hand only, never for an agent), denied every time with a one-line reason (fableReason),
//      and fail closed: a call whose `model` is Fable (the alias or any id) or `inherit`; with no `model`, an agent file that pins Fable,
//      `inherit` or nothing (with no CLAUDE_CODE_SUBAGENT_MODEL, or a Fable one); a pin that cannot be read or is not certain; a type
//      with no agent file the gate reads (a plugin agent, a fork, an unknown type: it runs only with a non-Fable `model` in the call).
//   1. Copy-branch brief (lib/copy-branch-brief.mjs): a writer brief that creates `<lane>-2` instead of continuing `<lane>` (deny once).
//   2. UI brief (lib/ui-brief-gate.mjs): a dev-pixel or pixel-qa brief that names no usable coverage matrix (`MATRIX: <path>`, or
//      `MATRIX: none: <reason>`) gets the ui-coverage init advice (deny once).
//   3. Main-agent cap (agent-budget.mjs claimMainSlot): at most MAX_AGENTS_PER_TYPE (3) lex, 3 dev and 3 tess launched from the main session run at once;
//      denied every time while full, and when the record cannot be read (fail closed). A call from inside a subagent (a helper) is
//      never capped. A launch a later gate denies gives its slot back (releaseMainSlot).
//   4. Writer isolation (lib/writer-agents.mjs, lib/agent-launches.mjs): a writer launched while another plain writer of this session
//      runs must be isolated (`isolation: "worktree"`, or a `worktree: <abs path>` brief field naming a linked worktree no open writer
//      holds) or read-only (a line starting `read-only:` or `scratchpad-only:`), else it is denied once with advice; a brief naming
//      more than one worktree is denied once too. Who writes: lib/agent-roles.mjs isWriterRole (dev, dev-ui, dev-pixel, dev-debug, tess-write;
//      never lex or the read-only agents; other types by their agent file). A record that cannot be read denies (fail closed).
// Exports: guardedAgentInput (pure), fableReason, UNREADABLE_INPUT, writerIsolationDeny, copyBranchBriefDeny.
// Invariants: the routing never blocks; each deny-once gate denies an identical call at most once per session; the hook never lets an
// Agent call through without the no-Fable gate's yes (bad input and a crash deny).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { claimMainSlot, mainCapReason, mainRouteReason, releaseMainSlot } from './agent-budget.mjs';
import { quotedValue } from './lib/agent-brief.mjs';
import { isWriterRole } from './lib/agent-roles.mjs';
import { copyBranchBriefAdvice } from './lib/copy-branch-brief.mjs';
import { recordAgentLaunch } from './lib/agent-launches.mjs';
import { isSessionId } from './lib/session-store.mjs';
import { uiBriefDeny } from './lib/ui-brief-gate.mjs';
import { agentTypeOf, isReadOnlyBrief, laneWorktreeOf, worktreeLineAdvice } from './lib/writer-agents.mjs';

const FORK_TYPE = 'fork';
const DEFAULT_MODEL = 'sonnet';
const PLAN_MODEL = 'opus';
// Built-in agent types that pin no model, in lower case (a type is matched in any case: `explore` is Explore); an omitted
// subagent_type means general-purpose.
const UNPINNED_BUILTIN_TYPES = ['general-purpose', 'explore', 'claude', 'claude-code-guide', 'statusline-setup'];
const PLAN_TYPE = 'plan';
const SEND_AGAIN = 'Send the same call again unchanged and it runs.';

/**
 * The Agent input with the model this call needs when it names none (the same in every mode).
 * @param {unknown} toolInput - `tool_input` of the Agent / Task call.
 * @returns {object | null} a copy of the input with `model` added, or null when nothing is to change.
 */
export function guardedAgentInput(toolInput) {
  if (toolInput === null || typeof toolInput !== 'object') return null;
  if (toolInput.model !== undefined && toolInput.model !== '') return null;
  const type = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type.toLowerCase() : toolInput.subagent_type;
  if (type === FORK_TYPE) return null;
  if (type === PLAN_TYPE) return { ...toolInput, model: PLAN_MODEL };
  const unpinned = type === undefined || type === '' || UNPINNED_BUILTIN_TYPES.includes(type);
  return unpinned ? { ...toolInput, model: DEFAULT_MODEL } : null;
}

const denyOutput = (reason) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`;

const WORKTREE_ISOLATION = 'worktree';
const PARALLEL_WRITER_ADVICE = 'Another writing agent of this session is still running in the shared folder: give this one `isolation: "worktree"`, '
  + 'or make its worktree first (`git worktree add -b <branch> <path> <base>`) and add the brief line `worktree: <absolute path>`, or wait for the '
  + 'running writer. Roles: `dev`, `dev-ui`, `dev-pixel`, `dev-debug` and `tess-write` write; a reading job goes to `lex-scout`, `dev-run`, `tess` or `tess-review` '
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
const INHERIT_MODEL = /^inherit$/i; // the agent runs on the lead's model, which the hook cannot see
const FABLE_RULE = 'Not started: Fable is never used for an agent (the owner chooses it by hand only)';
// Names the model the agent should run on, never a lower one: the shipped pins are opus for lex and dev, sonnet for tess
const NAME_A_MODEL = 'name the model its agent file should pin in the Agent call, never Fable (`model: "opus"` for lex and dev, `"sonnet"` for tess)';
/** The deny reason for unreadable hook input (the guard denies the Agent call rather than let the no-Fable gate pass). */
export const UNREADABLE_INPUT = 'agent-model-guard could not read its input';

/** The reason for a call that names its model, or '' when that model is neither Fable nor `inherit`. */
function callModelReason(model) {
  if (typeof model !== 'string') return `${FABLE_RULE}: the call's \`model\` is not text, so the model is unknown; ${NAME_A_MODEL}.`;
  if (FABLE_MODEL.test(model)) return `${FABLE_RULE}: leave \`model\` out of the Agent call (it was \`${quotedValue(model)}\`).`;
  if (INHERIT_MODEL.test(model)) return `${FABLE_RULE}: \`model: inherit\` runs the agent on the lead's model, which may be Fable; ${NAME_A_MODEL}.`;
  return '';
}

/** The reason for the pin of an agent file found for `type`, or '' when it runs on a known model other than Fable. */
function foundPinReason(type, pin, env, isPlainModelName) {
  const shown = quotedValue(type);
  if (typeof pin.model === 'string' && FABLE_MODEL.test(pin.model)) {
    return `${FABLE_RULE}: the \`${shown}\` agent file pins \`${quotedValue(pin.model)}\`; change its \`model\` line, and leave \`model\` out of the Agent call.`;
  }
  const fallback = env.CLAUDE_CODE_SUBAGENT_MODEL; // what Claude Code uses for a file with no model line (lib/agent-pins.mjs header)
  const model = pin.model ?? (typeof fallback === 'string' && fallback !== '' ? fallback : null);
  if (model !== null && !isPlainModelName(model)) { // quoted with escapes, a block scalar, a value below its line: not read as written
    return `${FABLE_RULE}: the \`${shown}\` agent's model \`${quotedValue(model)}\` is not a plain model name, so what it runs on is unknown; ${NAME_A_MODEL}.`;
  }
  if (pin.model === null && model !== null && FABLE_MODEL.test(model)) {
    return `${FABLE_RULE}: the \`${shown}\` agent file pins no model and CLAUDE_CODE_SUBAGENT_MODEL is \`${quotedValue(model)}\`; ${NAME_A_MODEL}.`;
  }
  if (model === null || INHERIT_MODEL.test(model)) {
    return `${FABLE_RULE}: the \`${shown}\` agent would run on the lead's model (no model pinned, or \`inherit\`), which may be Fable; ${NAME_A_MODEL}, or pin one in its file.`;
  }
  return '';
}

/**
 * The no-Fable gate (see the header). It fails closed: whenever the model the agent would run on is not known, the call is denied.
 * The model is the call's `model` when set (it outranks the agent file), else the built-in route's (guardedAgentInput: sonnet or
 * opus), else the pin of the agent file Claude Code loads (lib/agent-pins.mjs pinVerdict), else CLAUDE_CODE_SUBAGENT_MODEL.
 * Denied: a Fable model; `inherit` or no model at all (the lead's model, which may be Fable); a pin that cannot be read or is not
 * certain; a type with no agent file this gate reads (a plugin agent, a fork, an unknown type). Plugin agent files are not read: a
 * plugin agent runs only with a non-Fable `model` in the call.
 * @param {unknown} input the hook input: tool_input {subagent_type, model}, cwd
 * @param {Record<string, string | undefined>} env HOME / CLAUDE_CONFIG_DIR (where the agent files are), CLAUDE_CODE_SUBAGENT_MODEL
 * @returns {Promise<string>} the one-line deny reason, or '' when the agent runs on a known model other than Fable
 */
export async function fableReason(input, env = process.env) {
  const toolInput = input?.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return UNREADABLE_INPUT;
  const { subagent_type: type, model } = guardedAgentInput(toolInput) ?? toolInput;
  if (model !== undefined && model !== '') return callModelReason(model);
  const name = agentTypeOf(type);
  const shown = quotedValue(name);
  let verdict;
  let pins;
  try {
    pins = await import('./lib/agent-pins.mjs');
    verdict = pins.pinVerdict(name, typeof input.cwd === 'string' ? input.cwd : process.cwd(), env);
  } catch (error) {
    return `${FABLE_RULE}: the pin of \`${shown}\` cannot be read (${quotedValue(String(error?.message))}); fix the file, or ${NAME_A_MODEL}.`;
  }
  switch (verdict.state) {
    case 'found':
      return foundPinReason(name, verdict.pin, env, pins.isPlainModelName);
    case 'unsure':
      return `${FABLE_RULE}: which \`${shown}\` agent file Claude Code loads is not certain, so its model is unknown; ${NAME_A_MODEL}.`;
    case 'none':
      return `${FABLE_RULE}: \`${shown}\` has no agent file this gate reads (a plugin, fork or unknown type), so its model is unknown; ${NAME_A_MODEL}.`;
    default:
      return `${FABLE_RULE}: the pin of \`${shown}\` gave no answer; ${NAME_A_MODEL}.`;
  }
}

/** The deny line of the gates (header order), or '' when the call may run; a denied launch gives its main-agent slot back. */
async function gatesDeny(input) {
  const route = mainRouteReason(input);
  if (route !== '') return denyOutput(route);
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

/** @returns {Promise<object | null>} the hook input from stdin, or null when it is not a JSON object */
async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); // decoded once: a character split across chunks stays whole
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? input : null;
  } catch {
    return null; // not hook JSON: the caller denies (the no-Fable gate cannot run)
  }
}

async function main() {
  const input = await readHookInput();
  if (input === null) {
    process.stdout.write(denyOutput(UNREADABLE_INPUT));
    return;
  }
  const deny = await gatesDeny(input);
  if (deny !== '') {
    process.stdout.write(deny);
    return;
  }
  const routed = guardedAgentInput(input.tool_input);
  let floored = routed; // the pin floor fails open: a load or read error in lib/agent-pins.mjs leaves the input as it is
  try {
    const { flooredAgentInput } = await import('./lib/agent-pins.mjs');
    floored = flooredAgentInput(routed ?? input.tool_input, typeof input.cwd === 'string' ? input.cwd : process.cwd()) ?? routed;
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
    // fail closed: an Agent call is never let through by a guard that broke before the no-Fable gate could decide
    const message = String(error?.message).replace(/\s+/g, ' ');
    process.stderr.write(`agent-model-guard: ${message}\n`);
    process.stdout.write(denyOutput(`agent-model-guard failed (${quotedValue(message)}), so the call is denied; send it again, or fix the hook`));
  }
}
