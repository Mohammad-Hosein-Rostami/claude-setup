// The main-agent cap: at most MAX_MAIN_AGENTS (6) agents started from the main session (lex, dev, tess and any other the boss
// starts) run at once; helpers, started by another agent, are never capped. Nothing else: no call counts shown, no nudges, no
// report caps.
// Events: agent-model-guard.mjs (PreToolUse Agent|Task) calls claimMainSlot before a launch and releaseMainSlot when a later gate
// denies it; this hook records the rest. A call with `agent_id` in its input comes from inside a subagent, so it is a helper's.
//   PostToolUse in a subagent -> one byte appended to its call counter (lib/writer-agents.mjs callCounterPath): its mtime is the
//                                agent's last sign of work, read here and by lib/agent-launches.mjs (the writer gate).
//   SubagentStart -> the oldest pending main launch of that type becomes this agent; a stopped main agent that starts again (a
//                    resume by SendMessage) runs again; any other start is a helper's and is not recorded here. Also
//                    lib/agent-launches.mjs recordAgentStart for the guard's writer gate.
//   SubagentStop  -> its main launch ends; lib/agent-launches.mjs recordAgentStop; its call counter is removed.
// Running: a pending launch (no SubagentStart yet) for PENDING_MS, so a denied or cut launch frees its slot; a started one until its
// SubagentStop, or until STALE_MS passes with no tool call of its own (an agent that ended unseen); never a launch dated more than
// CLOCK_SKEW_MS ahead. Limit: SubagentStart names no parent, so a helper of the same type that starts while a main launch of that
// type is pending takes its place; the count stays right until the first of the two stops.
// Store: ~/.claude/state/main-agents/<session>.json through lib/session-store.mjs under lib/session-lock.mjs (0600, at most
// MAX_STORE_BYTES for writer and reader): {"launches": [{"key", "type", "at", "agent"?}], "stopped": [agent ids]}. A corrupt file
// reads as empty; an unusable store or a lock that stays taken is `unusable`, and the guard denies (the owner's cap fails closed).
// Main-agent route (mainRouteReason, the guard's first gate): only the boss starts lex, dev and tess, and they start their helpers.
// A main-session call of any other type is denied every time with the route to take. Default for Claude Code's built-ins: an
// omitted subagent_type (general-purpose), general-purpose, Explore, Plan, claude, fork and any plugin or unknown type are denied
// from the main session too; only claude-code-guide and statusline-setup (Claude Code's own help and config agents) are let
// through. A call from inside a subagent (`agent_id`) that starts lex, dev or tess is denied every time (owner rule: the boss
// knows who is on what, and the cap counts only its starts); the agent asks the boss with a `needs:` line instead. Any other
// type from inside a subagent is free: which helper each agent starts is set by its agent file, not here.
// Exports: MAX_MAIN_AGENTS, PENDING_MS, STALE_MS, MAIN_AGENT_TYPES, mainRouteReason, claimMainSlot, releaseMainSlot, mainCapReason,
// recordMainStart, recordMainStop.
// Invariants: never throws; the hook's own events fail open (exit 0, no output); output is fixed text, types and the store path.
import { appendFileSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { quotedValue } from './lib/agent-brief.mjs';
import { recordAgentStart, recordAgentStop } from './lib/agent-launches.mjs';
import { withSessionLock } from './lib/session-lock.mjs';
import { isSessionId, readSessionFile, writeSessionFile } from './lib/session-store.mjs';
import { agentTypeOf, callCounterPath } from './lib/writer-agents.mjs';

export const MAX_MAIN_AGENTS = 6; // the owner's limit of main agents at once (lex-dev-tess plan, "Rules")
export const PENDING_MS = 2 * 60 * 1000; // a launch the permission dialog, Esc or another hook stops gets no SubagentStart
export const STALE_MS = 3 * 60 * 60 * 1000; // 3 h with no tool call: longer than a main agent waits on its helpers
const CLOCK_SKEW_MS = 60 * 1000;
const MAX_STORE_BYTES = 64 * 1024;
const STOPPED_KEPT = 200; // stopped main agent ids kept for a resume
const KEY_BYTES = 8;
const SAFE_ID = /^[\w-]{1,128}$/;
const NO_STORE = { state: 'unusable', running: [] };

/** The agents the main session may start (the owner's design: the boss routes to lex, dev and tess only). */
export const MAIN_AGENT_TYPES = ['lex', 'dev', 'tess'];
// Claude Code's own help and config agents: no job work, so the boss may start them directly
const BOSS_BUILT_INS = ['claude-code-guide', 'statusline-setup'];
// Which main agent starts each helper of home/agents, so a deny names the route
const HELPER_OWNERS = {
  'lex-scout': 'lex', 'lex-web': 'lex',
  'dev-ui': 'dev', 'dev-pixel': 'dev', 'pixel-qa': 'dev', 'dev-debug': 'dev', 'dev-run': 'dev',
  'tess-review': 'tess',
};

/**
 * The deny reason for an Agent or Task call on the wrong route (see the header): the main session starting anything but a main
 * agent, or a subagent starting a main agent.
 * @param {unknown} input the PreToolUse hook input: agent_id (set inside a subagent), tool_input.subagent_type
 * @returns {string} one line naming the route, or '' when the call may go on (a subagent's helper, the boss's main agent, an
 *   allowed built-in)
 */
export function mainRouteReason(input) {
  const type = agentTypeOf(input?.tool_input?.subagent_type);
  if (input?.agent_id) {
    if (!MAIN_AGENT_TYPES.includes(type)) return '';
    return `agent route: only the boss starts lex, dev and tess; ask it with the line 'needs: ${type} to <task>, blocks: <what>' `
      + '(SendMessage to main from a background run, else in your report) and go on with what does not depend on it';
  }
  if (MAIN_AGENT_TYPES.includes(type) || BOSS_BUILT_INS.includes(type)) return '';
  const shown = quotedValue(type);
  const owner = Object.hasOwn(HELPER_OWNERS, type) ? HELPER_OWNERS[type] : undefined;
  if (owner) return `agent route: the boss starts lex, dev or tess; ${shown} is ${owner}'s helper: start ${owner} with the brief, and it starts ${shown}`;
  return `agent route: the boss starts lex, dev or tess; ${shown} is not one of them: start lex (research, design), dev (build, fix) or tess (checks) with the brief`;
}

const mainAgentsDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'main-agents');

/** The time of an agent's last tool call (its call counter's mtime), or 0 when it has made none. */
function lastToolCall(session, agentId) {
  const path = callCounterPath(session, agentId);
  try {
    return path === null ? 0 : statSync(path).mtimeMs;
  } catch {
    return 0; // no tool call yet
  }
}

/** Whether a stored launch still holds a slot (the rules in the header). */
function isRunning(launch, now, session) {
  if (launch.at > now + CLOCK_SKEW_MS) return false;
  if (typeof launch.agent !== 'string') return now - launch.at < PENDING_MS;
  return now - Math.max(launch.at, lastToolCall(session, launch.agent)) < STALE_MS;
}

const isLaunch = (launch) => typeof launch?.key === 'string' && typeof launch.type === 'string' && Number.isFinite(launch.at)
  && (launch.agent === undefined || SAFE_ID.test(launch.agent));

/** The store's running launches and stopped ids; a missing or corrupt file reads as empty. */
function parseRecord(text, now, session) {
  try {
    const record = text === null ? {} : JSON.parse(text);
    const launches = (Array.isArray(record?.launches) ? record.launches : []).filter((launch) => isLaunch(launch) && isRunning(launch, now, session));
    const stopped = (Array.isArray(record?.stopped) ? record.stopped : []).filter((id) => typeof id === 'string' && SAFE_ID.test(id));
    return { launches, stopped };
  } catch {
    return { launches: [], stopped: [] };
  }
}

/**
 * Runs change(record, now) on the session's record under its lock and stores what it returns as `record`.
 * @returns {object | undefined} change's answer; NO_STORE when the store cannot be read or written; undefined when the lock stays taken
 */
function withRecord(session, env, change) {
  const dir = mainAgentsDir(env);
  return withSessionLock(dir, session, () => {
    const now = Date.now();
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined) return NO_STORE;
    const answer = change(parseRecord(text, now, session), now);
    if (answer.record === undefined) return answer;
    const stored = JSON.stringify({ launches: answer.record.launches, stopped: answer.record.stopped.slice(-STOPPED_KEPT) });
    return writeSessionFile(dir, session, stored) ? answer : NO_STORE;
  });
}

/**
 * Claims a slot for an Agent or Task call of the main session, under the session's lock so parallel launches see each other.
 * @param {unknown} input the PreToolUse hook input: session_id, agent_id (set inside a subagent), tool_input.subagent_type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE (the store)
 * @returns {{state: 'helper' | 'unrecorded' | 'recorded' | 'full' | 'unusable', key?: string, running: Array<{type: string}>, storePath?: string}}
 *   helper: a call from inside a subagent (never capped); unrecorded: no usable session id (no store can be named); recorded: the
 *   slot is taken under `key`; full: MAX_MAIN_AGENTS run; unusable: the store cannot be read or written, or its lock stays taken
 */
export function claimMainSlot(input, env = process.env) {
  try {
    if (input?.agent_id) return { state: 'helper', running: [] };
    const session = input?.session_id;
    if (!isSessionId(session)) return { state: 'unrecorded', running: [] };
    const type = agentTypeOf(input.tool_input?.subagent_type);
    const done = withRecord(session, env, (record, now) => {
      if (record.launches.length >= MAX_MAIN_AGENTS) return { state: 'full', running: record.launches };
      const key = randomBytes(KEY_BYTES).toString('hex');
      const launches = [...record.launches, { key, type, at: now }];
      return { state: 'recorded', key, running: launches, record: { ...record, launches } };
    });
    const { state, key, running } = done ?? NO_STORE;
    return { state, ...(key ? { key } : {}), running, storePath: join(mainAgentsDir(env), `${session}.json`) };
  } catch {
    return NO_STORE;
  }
}

/**
 * Frees a slot claimMainSlot took for a launch that another gate then denied (it will never start).
 * @param {unknown} session hook input session_id
 * @param {unknown} key the `key` claimMainSlot returned
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @returns {boolean} true when a pending launch with that key was removed
 */
export function releaseMainSlot(session, key, env = process.env) {
  try {
    if (!isSessionId(session) || typeof key !== 'string') return false;
    const done = withRecord(session, env, (record) => {
      const launches = record.launches.filter((launch) => launch.key !== key || typeof launch.agent === 'string');
      return { released: launches.length < record.launches.length, record: { ...record, launches } };
    });
    return done?.released === true;
  } catch {
    return false;
  }
}

/**
 * The deny reason for a claim, or '' when the launch may go on.
 * @param {{state: string, running: Array<{type: string}>, storePath?: string}} claim claimMainSlot's answer
 * @returns {string} the cap text naming the running types (`full`), the fail-closed text naming the store (`unusable`), else ''
 */
export function mainCapReason({ state, running, storePath }) {
  if (state === 'unusable') return `agent cap: the main-agent record ${storePath ?? mainAgentsDir(process.env)} cannot be read or stays locked; fix or delete it, then launch again`;
  if (state !== 'full') return '';
  const types = running.map(({ type }) => quotedValue(type)).join(', ');
  return `agent cap: ${MAX_MAIN_AGENTS} main agents of this session run (${types}); wait for one to return (store: ${storePath})`;
}

/**
 * Marks a started agent as the main launch it belongs to (see the header); a helper's start changes nothing.
 * @returns {boolean} true when a main launch was marked started (or a stopped main agent runs again)
 */
export function recordMainStart(session, agentId, type, env = process.env) {
  try {
    if (!isSessionId(session) || typeof agentId !== 'string' || !SAFE_ID.test(agentId)) return false;
    const name = agentTypeOf(type);
    const done = withRecord(session, env, (record, now) => {
      if (record.launches.some((launch) => launch.agent === agentId)) return { started: false };
      if (record.stopped.includes(agentId)) {
        const launch = { key: randomBytes(KEY_BYTES).toString('hex'), type: name, at: now, agent: agentId };
        return { started: true, record: { launches: [...record.launches, launch], stopped: record.stopped.filter((id) => id !== agentId) } };
      }
      const index = record.launches.findIndex((launch) => launch.type === name && typeof launch.agent !== 'string');
      if (index === -1) return { started: false }; // a helper
      const launches = record.launches.map((launch, at) => (at === index ? { ...launch, at: now, agent: agentId } : launch));
      return { started: true, record: { ...record, launches } };
    });
    return done?.started === true;
  } catch {
    return false;
  }
}

/**
 * Ends the main launch of a stopped agent and keeps its id for a resume; a helper's stop changes nothing.
 * @returns {boolean} true when a main launch ended
 */
export function recordMainStop(session, agentId, env = process.env) {
  try {
    if (!isSessionId(session) || typeof agentId !== 'string' || !SAFE_ID.test(agentId)) return false;
    const done = withRecord(session, env, (record) => {
      const launches = record.launches.filter((launch) => launch.agent !== agentId);
      if (launches.length === record.launches.length) return { stopped: false };
      return { stopped: true, record: { launches, stopped: [...record.stopped, agentId] } };
    });
    return done?.stopped === true;
  } catch {
    return false;
  }
}

/** Appends one byte to a subagent's call counter (its mtime is the agent's last sign of work). */
function markToolCall(session, agentId) {
  const path = callCounterPath(session, agentId);
  if (path === null) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, '.');
}

/** Runs one hook event (see the header). */
function handle(input, env) {
  const { hook_event_name: event, session_id: session, agent_id: agentId, agent_type: type } = input ?? {};
  if (event === 'PostToolUse' && agentId) markToolCall(session, agentId);
  if (event === 'SubagentStart') {
    recordAgentStart(session, agentId, type, env); // the guard's writer gate: it really runs
    recordMainStart(session, agentId, type, env);
  }
  if (event === 'SubagentStop') {
    recordAgentStop(session, agentId, type, env);
    recordMainStop(session, agentId, env);
    const path = callCounterPath(session, agentId);
    if (path !== null) rmSync(path, { force: true });
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    handle(JSON.parse(raw), process.env);
  } catch {
    // fail open: a record hook must never block or trap an agent
  }
}
