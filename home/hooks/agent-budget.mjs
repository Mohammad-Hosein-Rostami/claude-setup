// The main-agent cap, per type: at most MAX_AGENTS_PER_TYPE (3) of each main agent type (lex, dev, tess started by the main session)
// run at once, so 9 in all; a full type never blocks the others. Helpers, started by another agent, and the boss's Claude Code
// built-ins (claude-code-guide, statusline-setup) are never capped. Nothing else: no call counts shown, no nudges, no report caps.
// Events: agent-model-guard.mjs (PreToolUse Agent|Task) calls claimMainSlot before a launch and releaseMainSlot when a later gate
// denies it, and (PreToolUse SendMessage) resumeCapReason before a message that would resume a stopped main agent; this hook
// records the rest. A call with `agent_id` in its input comes from inside a subagent, so it is a helper's.
//   PostToolUse in a subagent -> one byte appended to its call counter (lib/writer-agents.mjs callCounterPath): its mtime is the
//                                agent's last sign of work, read by lib/main-agents-store.mjs and lib/agent-launches.mjs. The entry
//                                is async in settings/base.json, so it may land after the agent's SubagentStop: that changes
//                                nothing, a stopped agent holds no launch.
//   SubagentStart -> the oldest pending main launch of that type becomes this agent; a stopped main agent that starts again (a
//                    resume by SendMessage) runs again; a running one that starts again (a resume after an end no hook saw) is
//                    re-dated to now; any other start is a helper's and is not recorded here. Also lib/agent-launches.mjs
//                    recordAgentStart for the guard's writer gate.
//   SubagentStop  -> its main launch ends and its type is kept for a resume; lib/agent-launches.mjs recordAgentStop; its call
//                    counter is removed.
// Running and the store: lib/main-agents-store.mjs (pending PENDING_MS, started until its stop or STALE_MS with no tool call).
// Ended unseen: an agent that dies on an API error (a usage limit) gets no SubagentStop. When a type is full, the launches of that
// type whose agent the lead's transcript shows ended after its start (lib/agent-ends.mjs) are moved to the stopped agents first,
// so the slot frees at once instead of after STALE_MS. The transcript is read only then, and before the lock is taken.
// Resume (U3): SubagentStart fires on a SendMessage resume but cannot block, so resumeCapReason checks the cap before the send;
// the resume then takes its slot at its SubagentStart. Two resumes or a resume and a launch in one message can pass together.
// Limit: SubagentStart names no parent, so a helper of the same type that starts while a main launch of that type is pending takes
// its place; the count stays right until the first of the two stops.
// The main-agent route (which types the boss and the subagents may start) is lib/agent-route.mjs, the guard's first gate.
// Exports: MAX_AGENTS_PER_TYPE, PENDING_MS and STALE_MS (lib/main-agents-store.mjs's), MAIN_AGENT_TYPES (lib/agent-route.mjs's),
// claimMainSlot, releaseMainSlot, mainCapReason, resumeCapReason, recordMainStart, recordMainStop.
// Invariants: never throws; the hook's own events and the resume cap fail open; claimMainSlot's caller denies on an unusable store;
// output is fixed text, types, agent ids and the store path.
import { appendFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { quotedValue } from './lib/agent-brief.mjs';
import { agentEndTimes } from './lib/agent-ends.mjs';
import { recordAgentStart, recordAgentStop } from './lib/agent-launches.mjs';
import { MAIN_AGENT_TYPES } from './lib/agent-route.mjs';
import { NO_STORE, PENDING_MS, SAFE_ID, STALE_MS, mainAgentsDir, peekRecord, withRecord } from './lib/main-agents-store.mjs';
import { isSessionId } from './lib/session-store.mjs';
import { agentTypeOf, callCounterPath } from './lib/writer-agents.mjs';

export const MAX_AGENTS_PER_TYPE = 3; // the owner's limit of running lex, of dev and of tess, each counted alone (owner, 2026-11-24)
const KEY_BYTES = 8;
const STARTING = 'starting'; // a launch with no SubagentStart yet has no agent id
const MAIN_SESSION = 'main'; // SendMessage's name for the lead session, never a resume

// kept here for their callers: the route's types and the store's running times
export { MAIN_AGENT_TYPES, PENDING_MS, STALE_MS };

/**
 * When the record read without the lock shows `type` full, the time the lead's transcript shows each started agent of that type
 * ended (lib/agent-ends.mjs). Read before the lock, as a big transcript takes longer than another hook waits for the lock; the
 * transcript is read only for a full type, to keep every other call cheap.
 * @returns {Map<string, number>} agent id -> epoch ms of its last end; empty when the type is not full or the store is unusable
 */
function endTimesWhenFull(peeked, type, transcriptPath) {
  const sameType = peeked === null ? [] : peeked.launches.filter((launch) => launch.type === type);
  if (sameType.length < MAX_AGENTS_PER_TYPE) return new Map();
  return agentEndTimes(transcriptPath, sameType.filter((launch) => typeof launch.agent === 'string').map((launch) => launch.agent));
}

/**
 * The record with every started launch of `type` whose agent ended after its start (`ends`, from endTimesWhenFull) moved to the
 * stopped agents, as a SubagentStop would: an agent that died on an API error gets no SubagentStop.
 * @returns {object} the same record when none ended
 */
function withoutEndedAgents(record, type, ends) {
  const started = record.launches.filter((launch) => launch.type === type && typeof launch.agent === 'string');
  const ended = started.filter((launch) => (ends.get(launch.agent) ?? 0) >= launch.at);
  if (ended.length === 0) return record;
  return {
    launches: record.launches.filter((launch) => !ended.includes(launch)),
    stopped: [...record.stopped, ...ended.map((launch) => launch.agent)],
    stoppedTypes: { ...record.stoppedTypes, ...Object.fromEntries(ended.map((launch) => [launch.agent, launch.type])) },
  };
}

/**
 * The running launches of `type` under the lock, after freeing the ones `ends` shows ended.
 * @returns {{ record: object, sameType: object[], changed: boolean }} `changed`: launches were freed, so the record must be stored
 */
function runningOfType(stored, type, ends) {
  const record = withoutEndedAgents(stored, type, ends);
  return { record, sameType: record.launches.filter((launch) => launch.type === type), changed: record !== stored };
}

/**
 * Claims a slot for an Agent or Task call of the main session, under the session's lock so parallel launches see each other.
 * @param {unknown} input the PreToolUse hook input: session_id, agent_id (set inside a subagent), tool_input.subagent_type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE (the store)
 * @returns {{state: 'helper' | 'unrecorded' | 'recorded' | 'full' | 'unusable', type?: string, key?: string, running: Array<{type: string, agent?: string}>, storePath?: string}}
 *   helper: a call from inside a subagent, or of a type that is no main agent (never capped); unrecorded: no usable session id (no store can be named); recorded: the
 *   slot is taken under `key` (`running`: every running launch); full: MAX_AGENTS_PER_TYPE of `type` run (`running`: those); unusable: the store cannot be read or written, or its lock stays taken
 */
export function claimMainSlot(input, env = process.env) {
  try {
    const type = agentTypeOf(input?.tool_input?.subagent_type);
    if (input?.agent_id || !MAIN_AGENT_TYPES.includes(type)) return { state: 'helper', running: [] };
    const session = input?.session_id;
    if (!isSessionId(session)) return { state: 'unrecorded', running: [] };
    const ends = endTimesWhenFull(peekRecord(session, env), type, input.transcript_path);
    const done = withRecord(session, env, (stored, now) => {
      const { record, sameType, changed } = runningOfType(stored, type, ends);
      if (sameType.length >= MAX_AGENTS_PER_TYPE) return { state: 'full', running: sameType, ...(changed ? { record } : {}) };
      const key = randomBytes(KEY_BYTES).toString('hex');
      const launches = [...record.launches, { key, type, at: now }];
      return { state: 'recorded', key, running: launches, record: { ...record, launches } };
    });
    const { state, key, running } = done ?? NO_STORE;
    return { state, type, ...(key ? { key } : {}), running, storePath: join(mainAgentsDir(env), `${session}.json`) };
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
 * @param {{state: string, type?: string, running: Array<{type: string, agent?: string}>, storePath?: string}} claim claimMainSlot's answer
 * @returns {string} the cap text naming the full type and its running agent ids (`starting` for one with no SubagentStart yet)
 *   (`full`), the fail-closed text naming the store (`unusable`), else ''
 */
export function mainCapReason({ state, type, running, storePath }) {
  if (state === 'unusable') return `agent cap: the main-agent record ${storePath ?? mainAgentsDir(process.env)} cannot be read or stays locked; fix or delete it, then launch again`;
  if (state !== 'full') return '';
  return `agent cap: ${MAX_AGENTS_PER_TYPE} ${quotedValue(String(type))} agents of this session run (${runningIds(running)}); wait for one of them to return; `
    + `the other types have their own ${MAX_AGENTS_PER_TYPE} (store: ${storePath})`;
}

/** The running agent ids of a cap text, `starting` for a launch with no SubagentStart yet. */
const runningIds = (running) => running.map(({ agent }) => (typeof agent === 'string' ? quotedValue(agent) : STARTING)).join(', ');

/** The type of a stopped main agent, or undefined when `agentId` is no stopped main agent the record knows the type of. */
const stoppedTypeOf = (record, agentId) => (record.stopped.includes(agentId) && Object.hasOwn(record.stoppedTypes, agentId)
  ? record.stoppedTypes[agentId] : undefined);

/** The agent id a SendMessage `to` names (`<name> [ref]` without its ref), or null for `main` or a value that is no agent id. */
function messageTarget(to) {
  if (typeof to !== 'string') return null;
  const name = to.replace(/ \[[^\]]*\]$/, '').trim();
  return name !== MAIN_SESSION && SAFE_ID.test(name) ? name : null;
}

/**
 * The deny reason for a SendMessage that would resume a stopped main agent while MAX_AGENTS_PER_TYPE of its type run, else ''.
 * Why here: SubagentStart fires on a resume (2.1.330, seen 2026-11-24: the resumed agent's start was recorded at the send's time)
 * but cannot block, so the cap is checked before the send, like a launch. A message to a running agent (queued, no resume), to
 * `main`, or to an id the record holds no type for (a helper, an agent stopped before types were kept) passes. The resume takes
 * no slot here: its SubagentStart does (recordMainStart). It fails open: a record that cannot be read or stays locked, and any
 * failure, let the message go, since a message starts no new agent (the no-Fable rule cannot be broken by it) and blocking it
 * would cut the lead off from its agents.
 * @param {unknown} input the PreToolUse(SendMessage) hook input: session_id, transcript_path, tool_input.to
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE (the store)
 * @returns {string} the cap text when the resume would exceed the cap, else ''
 */
export function resumeCapReason(input, env = process.env) {
  try {
    const session = input?.session_id;
    const target = messageTarget(input?.tool_input?.to);
    if (!isSessionId(session) || target === null) return '';
    const peeked = peekRecord(session, env);
    const ends = peeked === null ? new Map() : endTimesWhenFull(peeked, stoppedTypeOf(peeked, target), input.transcript_path);
    const done = withRecord(session, env, (stored) => {
      const type = stoppedTypeOf(stored, target);
      if (type === undefined) return { state: 'free' };
      const { record, sameType, changed } = runningOfType(stored, type, ends);
      const answer = sameType.length >= MAX_AGENTS_PER_TYPE ? { state: 'full', type, running: sameType } : { state: 'free' };
      return changed ? { ...answer, record } : answer;
    });
    const { state, type, running } = done ?? NO_STORE;
    const storePath = join(mainAgentsDir(env), `${session}.json`);
    if (state !== 'full') return ''; // an unusable record too: the message goes (fail open, see the doc comment)
    return `agent cap: ${MAX_AGENTS_PER_TYPE} ${quotedValue(type)} agents of this session run (${runningIds(running)}); this message would resume `
      + `${quotedValue(target)} as one more; wait for one of them to return, then send it again (store: ${storePath})`;
  } catch {
    return ''; // fail open, as for an unusable record
  }
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
      if (record.launches.some((launch) => launch.agent === agentId)) { // a resume of an agent that ended unseen: it starts again now
        const launches = record.launches.map((launch) => (launch.agent === agentId ? { ...launch, at: now } : launch));
        return { started: false, record: { ...record, launches } };
      }
      if (record.stopped.includes(agentId)) {
        const launch = { key: randomBytes(KEY_BYTES).toString('hex'), type: name, at: now, agent: agentId };
        const { [agentId]: _resumedType, ...stoppedTypes } = record.stoppedTypes;
        return { started: true, record: { launches: [...record.launches, launch], stopped: record.stopped.filter((id) => id !== agentId), stoppedTypes } };
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
      const ended = record.launches.find((launch) => launch.agent === agentId);
      if (ended === undefined) return { stopped: false };
      const launches = record.launches.filter((launch) => launch !== ended);
      const stoppedTypes = { ...record.stoppedTypes, [agentId]: ended.type }; // the type a resume is capped by (resumeCapReason)
      return { stopped: true, record: { launches, stopped: [...record.stopped, agentId], stoppedTypes } };
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
