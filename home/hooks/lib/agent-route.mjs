// The main-agent route, the first gate of agent-model-guard.mjs: only the boss starts lex, dev, tess and max (the ship agent, started
// rarely), and they start their helpers.
// A main-session call of any other type is denied every time with the route to take. Default for Claude Code's built-ins: an
// omitted subagent_type (general-purpose), general-purpose, Explore, Plan, claude, fork and any plugin or unknown type are denied
// from the main session too; only claude-code-guide and statusline-setup (Claude Code's own help and config agents) are let
// through. A call from inside a subagent (`agent_id`) that starts lex, dev, tess or max is denied every time (owner rule: the boss
// knows who is on what, and the cap counts only its starts); the agent asks the boss with a `needs:` line instead. Any other
// type from inside a subagent is free: which helper each agent starts is set by its agent file, not here.
// Exports: MAIN_AGENT_TYPES, mainRouteReason.
// Invariants: pure (reads only its input); the reason is fixed text plus the quoted type.
import { quotedValue } from './agent-brief.mjs';
import { agentTypeOf } from './writer-agents.mjs';

/** The agents the main session may start (the owner's design: the boss routes to lex, dev and tess, and rarely to max). */
export const MAIN_AGENT_TYPES = ['lex', 'dev', 'tess', 'max'];
// Claude Code's own help and config agents: no job work, so the boss may start them directly
const BOSS_BUILT_INS = ['claude-code-guide', 'statusline-setup'];
// Which main agent starts each helper of home/agents, so a deny names the route
const HELPER_OWNERS = {
  'lex-scout': 'lex', 'lex-web': 'lex',
  'dev-part': 'dev', 'dev-docs': 'dev', 'dev-ui': 'dev', 'dev-pixel': 'dev', 'pixel-qa': 'dev', 'dev-debug': 'dev', 'dev-run': 'dev',
  'tess-review': 'tess', 'tess-write': 'tess', 'tess-simple': 'tess', 'tess-edge': 'tess', 'tess-run': 'tess',
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
    return `agent route: only the boss starts lex, dev, tess and max; ask it with the line 'needs: ${type} to <task>, blocks: <what>' `
      + '(SendMessage to main from a background run, else in your report) and go on with what does not depend on it';
  }
  if (MAIN_AGENT_TYPES.includes(type) || BOSS_BUILT_INS.includes(type)) return '';
  const shown = quotedValue(type);
  const owner = Object.hasOwn(HELPER_OWNERS, type) ? HELPER_OWNERS[type] : undefined;
  if (owner) return `agent route: the boss starts lex, dev, tess or max; ${shown} is ${owner}'s helper: start ${owner} with the brief, and it starts ${shown}`;
  return `agent route: the boss starts lex, dev, tess or max; ${shown} is not one of them: start lex (research, design), dev (build, fix), tess (checks) or max (ship, release, production) with the brief`;
}
