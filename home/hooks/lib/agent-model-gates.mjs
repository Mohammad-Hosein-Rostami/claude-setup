// The gates and the model routing of the PreToolUse(Agent|Task) guard; home/hooks/agent-model-guard.mjs is its entry, which loads this
// file inside a try, so a lib that fails to load denies the call instead of exiting 1 (fail open). Model routing: an Agent call with no `model` runs on the lead's own model and spends it silently, so a
// call to a built-in type that pins no model (general-purpose, no subagent_type, Explore and the other built-ins) gets `sonnet` and a
// Plan call gets `opus` (types matched in any case: `explore`, `plan`). Forks (subagent_type "fork"), plugin agents and an explicit
// model are not routed, and nothing is routed while CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on under every env the session may run with (Claude Code then ignores `model`). Input that is not a JSON object, and any crash of the guard, deny the call (the no-Fable gate fails closed).
// Pin floor (lib/agent-pins.mjs): the agent file Claude Code loads sets a floor for its own model and effort, so a lower per-call
// value is left out (haiku < sonnet < opus; low < ... < max); this is how each agent keeps the pin of the plan (lex, dev, dev-ui,
// dev-pixel, dev-debug, tess-review, tess-write on Opus; lex-web, pixel-qa, tess, dev-part, tess-simple, tess-edge on Sonnet; lex-scout,
// dev-run on Haiku: the frontmatter of home/agents/<name>.md). A failure there leaves the input as it is (stderr line). A rewrite is
// allow + the full updatedInput.
// Gates, in order (the first deny wins; each deny-once gate lets the identical call through when it is sent again):
//   R. Main-agent route (lib/agent-route.mjs mainRouteReason): the main session starts only lex, dev and tess (and Claude Code's
//      claude-code-guide and statusline-setup); any other type from the main session is denied every time with the route to take.
//      A call from inside a subagent (`agent_id`) that starts lex, dev or tess is denied every time too: only the boss starts them,
//      and the agent asks for one with a `needs:` line; its other calls (its helpers) are not routed. First, so a wrong route spends
//      no deny-once gate.
//   0. No Fable (owner rule: Fable is chosen by hand only, never for an agent), denied every time with a one-line reason (fableReason;
//      the reason texts are lib/fable-model-reasons.mjs),
//      and fail closed: a call whose `model` is Fable (the alias or any id), `inherit` or an alias resolved at run time (`best`,
//      `default`, `opusplan`); with no `model`, an agent file that pins Fable, such an alias, `inherit` or nothing (with no
//      CLAUDE_CODE_SUBAGENT_MODEL, or a Fable or alias one); with CLAUDE_CODE_SUBAGENT_MODEL_FORCE on, a CLAUDE_CODE_SUBAGENT_MODEL
//      that is unset, `inherit`, Fable or such an alias (it then decides every agent's model), or a Fable or alias call model; any call
//      while ANTHROPIC_DEFAULT_OPUS_MODEL, _SONNET_, _HAIKU_ or ANTHROPIC_DEFAULT_MODEL names Fable (it re-points an alias); a pin that cannot be read or is not certain; a type
//      with no agent file the gate reads (a plugin agent, a fork, an unknown type: it runs only with a non-Fable `model` in the call).
//      These variables are read from the hook's env and from the settings files' `env` (lib/settings-env.mjs possibleEnvs: the call
//      must pass under each env the session may run with, the force and CLAUDE_CODE_SUBAGENT_MODEL also taken from different ones);
//      a settings file that exists but cannot be read denies every call, naming the file and the cause.
//   1. Copy-branch brief (lib/copy-branch-brief.mjs): a writer brief that creates `<lane>-2` instead of continuing `<lane>` (deny once).
//   2. UI brief (lib/ui-brief-gate.mjs): a dev-pixel or pixel-qa brief that names no usable coverage matrix (`MATRIX: <path>`, or
//      `MATRIX: none: <reason>`) gets the ui-coverage init advice (deny once).
//   3. Main-agent cap (agent-budget.mjs claimMainSlot): at most MAX_AGENTS_PER_TYPE (3) lex, 3 dev and 3 tess launched from the main session run at once;
//      denied every time while full, and when the record cannot be read (fail closed). A call from inside a subagent (a helper) is
//      never capped. A launch a later gate denies gives its slot back (releaseMainSlot).
//   4. Writer isolation (lib/writer-agents.mjs, lib/agent-launches.mjs): a writer launched while another plain writer of this session
//      runs must be isolated (`isolation: "worktree"`, or a `worktree: <abs path>` brief field naming a linked worktree no open writer
//      holds) or read-only (a line starting `read-only:` or `scratchpad-only:`), else it is denied once with advice; a brief naming
//      more than one worktree is denied once too. Who writes: lib/agent-roles.mjs isWriterRole (dev, dev-part, dev-ui, dev-pixel, dev-debug, tess-write;
//      never lex or the read-only agents; other types by their agent file). A record that cannot be read denies (fail closed).
// SendMessage (its own PreToolUse entry) runs none of the gates above: its only gate is the main-agent cap for a message that would resume a stopped lex,
// dev or tess (agent-budget.mjs resumeCapReason), denied every time while 3 of its type run. It fails open: a record it cannot read,
// a target it cannot classify and a crash let the message go (a message starts no new agent, so it cannot start Fable).
// Exports: guardedAgentInput (pure), parseHookInput (pure), fableReason, UNREADABLE_INPUT, writerIsolationDeny, copyBranchBriefDeny, runGuard.
// Invariants: the routing never blocks; each deny-once gate denies an identical call at most once per session; the hook never lets an
// Agent call through without the no-Fable gate's yes (bad input and a crash deny).
import { claimMainSlot, mainCapReason, releaseMainSlot, resumeCapReason } from '../agent-budget.mjs';
import { quotedValue } from './agent-brief.mjs';
import { isWriterRole } from './agent-roles.mjs';
import { mainRouteReason } from './agent-route.mjs';
import { copyBranchBriefAdvice } from './copy-branch-brief.mjs';
import { recordAgentLaunch } from './agent-launches.mjs';
import { isSessionId } from './session-store.mjs';
import { mixedEnvs, possibleEnvs, unreadableCause } from './settings-env.mjs';
import { FABLE_RULE, NAME_A_MODEL, callModelReason, forcedModelReason, foundPinReason, isModelForced, remappedAliasReason,
  unreadableSettingsReason } from './fable-model-reasons.mjs';
import { uiBriefDeny } from './ui-brief-gate.mjs';
import { agentTypeOf, isReadOnlyBrief, laneWorktreeOf, worktreeLineAdvice } from './writer-agents.mjs';

const FORK_TYPE = 'fork';
const DEFAULT_MODEL = 'sonnet';
const PLAN_MODEL = 'opus';
// Built-in agent types that pin no model, in lower case (a type is matched in any case: `explore` is Explore); an omitted
// subagent_type means general-purpose.
const UNPINNED_BUILTIN_TYPES = ['general-purpose', 'explore', 'claude', 'claude-code-guide', 'statusline-setup'];
const PLAN_TYPE = 'plan';
const SEND_AGAIN = 'Send the same call again unchanged and it runs.';
const SEND_MESSAGE_TOOL = 'SendMessage'; // settings/base.json runs this guard on it too, for the resume cap

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
  + 'running writer. Roles: `dev`, `dev-part`, `dev-ui`, `dev-pixel`, `dev-debug` and `tess-write` write; a reading job goes to `lex-scout`, `dev-run`, `tess` or `tess-review` '
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
    const { adviceOnce } = await import('./bounce-once.mjs');
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
    const { adviceOnce } = await import('./bounce-once.mjs');
    const call = { command: `copy-branch brief: ${String(type)}: ${String(prompt)}`, cwd, input, hook: 'agent-model-guard', tool: 'Agent', logged: { type, class: COPY_BRANCH_CLASS } };
    if (adviceOnce([verdict.reason], call, env) !== '') return denyOutput([`Not started: ${verdict.reason}`, SEND_AGAIN].join('\n'));
    return '';
  } catch {
    return ''; // a quality hint, not a safety rule: any failure lets the call run
  }
}

/** The deny reason for unreadable hook input (the guard denies the Agent call rather than let the no-Fable gate pass). */
export const UNREADABLE_INPUT = 'agent-model-guard could not read its input';
// read together: the force decides whether the model variable is used, and each may come from another source (mixedEnvs)
const FORCE_AND_MODEL_VARS = ['CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_SUBAGENT_MODEL'];

/**
 * The no-Fable gate (see the header). It fails closed: whenever the model the agent would run on is not known, the call is denied.
 * While an ANTHROPIC_DEFAULT_*_MODEL alias variable names Fable, every call is denied. With CLAUDE_CODE_SUBAGENT_MODEL_FORCE on (as
 * Claude Code reads it), the model is CLAUDE_CODE_SUBAGENT_MODEL, and the call's own model is checked too (lib/fable-model-reasons.mjs).
 * Otherwise the model is the call's `model` when set (it outranks the agent file), else the built-in route's (guardedAgentInput: sonnet or
 * opus), else the pin of the agent file Claude Code loads (lib/agent-pins.mjs pinVerdict), else CLAUDE_CODE_SUBAGENT_MODEL.
 * Denied: a Fable model; an alias resolved only at run time (`best`, `default`, `opusplan`); `inherit` or no model at all (the lead's model, which may be Fable); a pin that cannot be read or is not
 * certain; a type with no agent file this gate reads (a plugin agent, a fork, an unknown type). Plugin agent files are not read: a
 * plugin agent runs only with a non-Fable `model` in the call.
 * The model variables count from the hook's env and from the settings files' `env` alike (lib/settings-env.mjs possibleEnvs), the
 * force and CLAUDE_CODE_SUBAGENT_MODEL also from different ones (mixedEnvs); a settings file that exists but cannot be read denies.
 * @param {unknown} input the hook input: tool_input {subagent_type, model}, cwd
 * @param {Record<string, string | undefined>} env HOME / CLAUDE_CONFIG_DIR (where the agent files and the user settings are),
 *   CLAUDE_PROJECT_DIR (the project settings), CLAUDE_CODE_SUBAGENT_MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE
 * @returns {Promise<string>} the one-line deny reason, or '' when the agent runs on a known model other than Fable under every env
 */
export async function fableReason(input, env = process.env) {
  const toolInput = input?.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return UNREADABLE_INPUT;
  // the model variables may be set only in a settings file's `env`, which the hook's process.env lacks (lib/settings-env.mjs);
  // the call must pass under every env the session may run with, and a file that cannot be read may name Fable
  const { envs, unreadableFile } = possibleEnvs(env, input.cwd);
  if (unreadableFile !== null) return unreadableSettingsReason(unreadableFile, unreadableCause(unreadableFile));
  for (const sessionEnv of mixedEnvs(envs, FORCE_AND_MODEL_VARS)) {
    const reason = await modelReason(input, sessionEnv);
    if (reason !== '') return reason;
  }
  return '';
}

/** fableReason for one env the session may run with (input.tool_input is an object). */
async function modelReason(input, env) {
  const toolInput = input.tool_input;
  const remapped = remappedAliasReason(env); // an alias env value that names Fable: every alias may be Fable
  if (remapped !== '') return remapped;
  if (isModelForced(env)) return forcedModelReason(toolInput.model, env); // Claude Code ignores the pin then
  const { subagent_type: type, model } = guardedAgentInput(toolInput) ?? toolInput;
  if (model !== undefined && model !== '') return callModelReason(model);
  const name = agentTypeOf(type);
  const shown = quotedValue(name);
  let verdict;
  let pins;
  try {
    pins = await import('./agent-pins.mjs');
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

/** @returns {object | null} the hook input, or null when the text is not a JSON object */
export function parseHookInput(text) {
  try {
    const input = JSON.parse(text);
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? input : null;
  } catch {
    return null; // not hook JSON: the caller denies (the no-Fable gate cannot run)
  }
}

/**
 * Runs the guard once on the hook input and prints the deny, the allow with the routed input, or nothing.
 * @param {string} text the hook input as read from stdin by the entry (agent-model-guard.mjs)
 * @returns {Promise<void>}
 * @throws on any failure the gates do not catch themselves (the entry turns it into a deny, or for SendMessage lets it pass)
 */
export async function runGuard(text) {
  const input = parseHookInput(text);
  if (input === null) {
    process.stdout.write(denyOutput(UNREADABLE_INPUT));
    return;
  }
  if (input.tool_name === SEND_MESSAGE_TOOL) { // only the resume cap; it fails open (a message starts no new agent, so no Fable)
    const capped = resumeCapReason(input);
    if (capped !== '') process.stdout.write(denyOutput(capped));
    return;
  }
  const deny = await gatesDeny(input);
  if (deny !== '') {
    process.stdout.write(deny);
    return;
  }
  // with the force on (as Claude Code reads it), Claude Code drops `model` from the Agent tool and ignores it, so the routing adds none;
  // only when it is on under every env the session may run with (it may be set only in a settings file, or only in one that never applies)
  const forced = possibleEnvs(process.env, input.cwd).envs.every(isModelForced);
  const routed = forced ? null : guardedAgentInput(input.tool_input);
  let floored = routed; // the pin floor fails open: a load or read error in lib/agent-pins.mjs leaves the input as it is
  try {
    const { flooredAgentInput } = await import('./agent-pins.mjs');
    floored = flooredAgentInput(routed ?? input.tool_input, typeof input.cwd === 'string' ? input.cwd : process.cwd()) ?? routed;
  } catch (error) {
    process.stderr.write(`agent-model-guard: pin floor skipped: ${error.message}\n`);
  }
  if (!floored) return;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: floored } }));
}
