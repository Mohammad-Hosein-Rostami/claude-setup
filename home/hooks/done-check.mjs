// Stop and SubagentStop: the done-check (design sections 3.1, 3.4, 3.5, 6, 12). When the code this agent (or the lead) changed differs
// from anything checked before, it runs the project's own checks through tools/done-check (lib/check-change.mjs) and answers with one
// status line for the owner. Wired on Stop and SubagentStop in settings/base.json.
// Output (stdout, one JSON line, exit 0 always): {"decision":"block","reason","systemMessage"} | {"systemMessage"} | nothing.
//   Nothing is printed when no code changed (the idle stop costs one `git status`, no tool, no ledger row), for any input that is not a
//   Stop or SubagentStop JSON with a safe session id, when the tool folder is missing (rollback), and on any internal error.
// Platform facts used (spec section 12, hooks.md "Stop" and "JSON output"; probe: `grep -a` in the 2.1.329 binary):
//   - `decision: "block"` with `reason` continues the turn; `stop_hook_active` is true on the stop that follows such a continuation.
//   - `systemMessage` is "Warning message shown to the user": the one line.
//   - Claude Code ends a turn after 8 blocks in a row (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP); this hook's own cap is MAX_BLOCKS_IN_A_ROW (2)
//     and is never near it. A hook that crashes or times out lets the stop through (`onFailure` has no effect on Stop): the land check is
//     the hard gate, and countedGate (lib/stop-block-count.mjs) leaves a record of such a crash.
//   - U1, unprobed: whether a SubagentStop `systemMessage` reaches the owner or the lead. Default: the owner only; the lead reads
//     `done-check last`. The block `reason` always reaches the agent.
// Block rules (the engine decides, this hook keeps the state): per (session, agent), `lastKey` per worktree = the change key of the last
//   block there, and `inARow` = blocks since the chain began. The same key again -> left open. `inARow` at MAX_BLOCKS_IN_A_ROW -> left
//   open with "change approach". A stop that is not a continuation (stop_hook_active not true) starts a new chain (`inARow` 0), so an old
//   chain never silences a later one; a green or reused stop forgets the worktree's `lastKey`.
// State: ~/.claude/state/done-check/blocks/<session>.json through lib/session-store.mjs, read and written under lib/session-lock.mjs
//   (two agents of one session take turns). Stale: the store removes files older than 7 days; a half or foreign file reads as empty (a block
//   may repeat once); a store that cannot be read or written never blocks (no state, no loop): the block is dropped to a pass and the
//   line still shows the failure (the ledger row says `block`).
// Failure: a check that could not run is `not-run` in the line and never blocks. One deadline (HOOK_DEADLINE_MS, below the 150 s entry
//   timeout) covers stdin, scope, the checks of every worktree and the base compares; past it the process exits 0 with nothing printed.
//   An internal error is one guard-log line and a pass; a missing tool folder is silent.
// Trust: the input crosses the agent boundary: session and agent ids are checked as file names, the folder comes from the hooks' own
//   records (scope.mjs), never from the input's `cwd`; the line and reason are built by the engine from counts and tool output lines.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logDecision } from './lib/guard-log.mjs';
import { withSessionLock } from './lib/session-lock.mjs';
import { isSessionId, readSessionFile, writeSessionFile } from './lib/session-store.mjs';
import { countedGate } from './lib/stop-block-count.mjs';

const HOOK_NAME = 'done-check';
const HOOK_DEADLINE_MS = 140_000; // the settings entry timeout is 150 s
const BASE_MARGIN_MS = 5_000; // left for the ledger write and the exit after the base compare
const MIN_CHECK_MS = 1_000;
const MAX_INPUT_BYTES = 8 * 1024 * 1024; // a Stop JSON holds the last reply; more than this is not one of Claude Code's
const STOP_EVENTS = new Set(['Stop', 'SubagentStop']);
const SAFE_ID = /^[\w-]{1,128}$/;
const STATE_MAX_BYTES = 64 * 1024;
const AGENTS_KEPT = 50;
const TOPS_KEPT = 8;
const KEY_CHARS = 16;
const LEAD = 'lead';

const blocksDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'done-check', 'blocks');
const agentOf = (input) => (typeof input.agent_id === 'string' && input.agent_id !== '' ? input.agent_id : LEAD);
const agentSlot = (agent) => `a:${agent}`; // a prefix, so no id can be `__proto__`
const topKey = (top) => createHash('sha256').update(top ?? '').digest('hex').slice(0, KEY_CHARS);

/** The stdin JSON as an object, or null: empty, too big, not JSON, not an object, not a Stop event or an unsafe session or agent id. */
async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null; // not JSON: not a hook call
  }
  const plain = input !== null && typeof input === 'object' && !Array.isArray(input);
  if (!plain || !STOP_EVENTS.has(input.hook_event_name) || !isSessionId(input.session_id)) return null;
  if (input.agent_id !== undefined && !(typeof input.agent_id === 'string' && (input.agent_id === '' || SAFE_ID.test(input.agent_id)))) return null;
  return input;
}

/** The stored block state of this agent: {lastKeys: {topHash: key}, inARow, usable}; `usable` is false when the store cannot be used. */
function loadBlocks(input, env) {
  const text = readSessionFile(blocksDir(env), input.session_id, STATE_MAX_BYTES);
  if (text === undefined) return { lastKeys: {}, inARow: 0, usable: false };
  let entry = null;
  try {
    entry = text === null ? null : JSON.parse(text)?.agents?.[agentSlot(agentOf(input))];
  } catch {
    entry = null; // a half or foreign file: empty
  }
  const lastKeys = entry !== null && typeof entry?.lastKeys === 'object' && entry.lastKeys !== null && !Array.isArray(entry.lastKeys) ? entry.lastKeys : {};
  const inARow = input.stop_hook_active === true && Number.isInteger(entry?.inARow) && entry.inARow > 0 ? entry.inARow : 0;
  return { lastKeys, inARow, usable: true };
}

/** Stores this agent's new state under the session lock (other agents' entries are kept). @returns {boolean} true when stored */
function saveBlocks(input, env, { lastKeys, inARow }) {
  const dir = blocksDir(env);
  const stored = withSessionLock(dir, input.session_id, () => {
    let agents = {};
    try {
      const parsed = JSON.parse(readSessionFile(dir, input.session_id, STATE_MAX_BYTES) ?? '{}')?.agents;
      agents = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      agents = {}; // a half file is replaced
    }
    const kept = Object.entries({ ...agents, [agentSlot(agentOf(input))]: { lastKeys: Object.fromEntries(Object.entries(lastKeys).slice(-TOPS_KEPT)), inARow } });
    return writeSessionFile(dir, input.session_id, JSON.stringify({ v: 1, agents: Object.fromEntries(kept.slice(-AGENTS_KEPT)) }));
  });
  return stored === true;
}

/** Checks every changed worktree in turn, each with what is left of the one deadline; returns the verdicts with their worktree. */
async function checkScopes(scopes, input, env, state, startedAt, { checkChange, constants }) {
  const results = [];
  for (const scope of scopes) {
    const left = HOOK_DEADLINE_MS - (Date.now() - startedAt) - constants.BASE_DEADLINE_MS - BASE_MARGIN_MS;
    const deadlineMs = Math.max(MIN_CHECK_MS, Math.min(constants.STOP_DEADLINE_MS, left));
    const priorBlocks = { lastKey: state.lastKeys[topKey(scope.top)] ?? null, inARow: state.inARow };
    results.push({ scope, verdict: await checkChange(scope, { where: 'stop', session: input.session_id, agent: input.agent_id ?? '', env, deadlineMs, priorBlocks }) });
  }
  return results;
}

/** The new block state after these verdicts: a block remembers its key, a green run forgets the worktree's key, a chain counts its blocks. */
function nextBlocks(results, state) {
  const lastKeys = { ...state.lastKeys };
  for (const { scope, verdict } of results) {
    if (['block', 'left-open'].includes(verdict.verdict)) lastKeys[topKey(scope.top)] = verdict.row.key;
    else if (['ok', 'reused'].includes(verdict.verdict)) delete lastKeys[topKey(scope.top)];
  }
  const blocked = results.some(({ verdict }) => verdict.verdict === 'block');
  const green = results.every(({ verdict }) => verdict.verdict !== 'left-open' && verdict.verdict !== 'block');
  return { lastKeys, inARow: blocked ? state.inARow + 1 : green ? 0 : state.inARow };
}

/**
 * The decision of one stop.
 * @param {object} input the validated Stop or SubagentStop JSON
 * @param {Record<string, string|undefined>} env the process environment (HOME, CLAUDE_PROJECT_DIR, DONE_CHECK_SKIP)
 * @param {number} startedAt Date.now() at the hook's start (the one deadline counts from it)
 * @param {{ownChange: Function, checkChange: Function, constants: object}} tools the done-check engine, loaded by `loadTools`
 * @returns {Promise<{block: boolean, reason?: string, line?: string} | null>} null when no code changed
 */
async function decide(input, env, startedAt, tools) {
  const { ownChange, checkChange, constants } = tools;
  const scopes = await ownChange(input, env);
  if (scopes.length === 0) return null;
  const state = loadBlocks(input, env);
  const results = await checkScopes(scopes, input, env, state, startedAt, { checkChange, constants });
  const next = nextBlocks(results, state);
  const blocking = results.filter(({ verdict }) => verdict.verdict === 'block');
  const line = results.map(({ verdict }) => verdict.line).join(' | ');
  const saved = state.usable && saveBlocks(input, env, next);
  if (blocking.length === 0 || !saved) return { block: false, line }; // a block that cannot be remembered would repeat: it passes
  return { block: true, line, reason: blocking.map(({ verdict }) => verdict.reason).join('\n\n') };
}

/** The engine of tools/done-check; throws ERR_MODULE_NOT_FOUND when that folder is missing (a rollback), before any gate mark is left. */
async function loadTools() {
  const [{ ownChange }, { checkChange }, constants] = await Promise.all([
    import('../tools/done-check/lib/scope.mjs'), import('../tools/done-check/lib/check-change.mjs'), import('../tools/done-check/lib/contract.mjs'),
  ]);
  return { ownChange, checkChange, constants };
}

async function main() {
  const startedAt = Date.now();
  setTimeout(() => process.exit(0), HOOK_DEADLINE_MS).unref(); // past it the stop goes through; the land check is the hard gate
  const input = await readInput();
  if (input === null) return;
  const tools = await loadTools();
  const result = await countedGate(HOOK_NAME, input, () => decide(input, process.env, startedAt, tools), process.env);
  if (result === null) return;
  const output = result.block ? { decision: 'block', reason: result.reason, systemMessage: result.line } : { systemMessage: result.line };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') { // a missing tool folder (rollback) is silent; anything else is one log line
      logDecision({ hook: HOOK_NAME, tool: 'Stop', decision: 'allow', outcome: 'error', reason: `done-check: ${String(error?.message ?? error).split('\n')[0]} (stop allowed)` });
    }
  }
  process.exitCode = 0;
}
