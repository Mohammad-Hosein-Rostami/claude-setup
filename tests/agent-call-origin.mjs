// Who sends an Agent call in the guard tests, so a test of another gate passes the route gate (agent-budget.mjs mainRouteReason).
// Exports: FROM_AGENT, FROM_BOSS, originOf(type).
// Invariant: originOf matches the real route: only the boss (no agent_id) starts lex, dev and tess; every other type is started from
// inside a main agent (agent_id), since the boss may not start it.
import { MAIN_AGENT_TYPES } from '../home/hooks/agent-budget.mjs';

/** The hook input fields of a call made from inside a running dev (a helper launch). */
export const FROM_AGENT = Object.freeze({ agent_id: 'agent-dev-1', agent_type: 'dev' });
/** The hook input fields of a call made by the main session (no agent_id). */
export const FROM_BOSS = Object.freeze({ agent_id: undefined, agent_type: undefined });

/**
 * The origin the route lets through for an agent type.
 * @param {unknown} type the call's subagent_type
 * @returns {Readonly<{agent_id?: string, agent_type?: string}>} FROM_BOSS for lex, dev and tess, else FROM_AGENT
 */
export const originOf = (type) => (MAIN_AGENT_TYPES.includes(type) ? FROM_BOSS : FROM_AGENT);
