// max's outward rule (owner, plans M2 and M2b): while a max agent runs, an outward ask runs only after a click on Allow. No answer, a
// failed dialog and no GUI deny, and CLAUDE_GUARD_ASK=allow never skips the dialog (lib/timed-ask.mjs applies the rule).
// Who it covers: an outward ask from max itself (the hook input's agent_type), and, while any max runs on this machine, every outward
// ask anywhere: a helper max starts has its own agent_type and a `claude -p` it starts is a new session, so neither names max; the
// record of the main-agent cap (lib/main-agents-store.mjs anyRunning) is the one place that knows a max runs. An unreadable record
// counts as a running max (fail closed). A max that died unseen keeps the rule only until STALE_MS passes with no tool call of its own.
// No new dialog: an outward ask already opens one; only its no-answer default changes from "goes ahead" to "does not run".
// Exports: CLICK_ONLY_AGENT_TYPE, clickOnlyNote(request, env), needsClickedAllow(request, env).
// Invariants: never throws (anyRunning never throws); reads the store only for an outward request that is not max's own.
import { anyRunning } from './main-agents-store.mjs';

export const CLICK_ONLY_AGENT_TYPE = 'max'; // the agent that prepares a ship and acts outward only on the owner's explicit yes
const OWN_NOTE = 'an outward action from max runs only after a click on Allow';
const RUNNING_NOTE = 'a max agent is running: outward actions run only after a click on Allow';
const UNREADABLE_NOTE = 'the record of running max agents cannot be read: outward actions run only after a click on Allow';

/**
 * Why a request runs only after a click on Allow, for the dialog's timeout line and the deny reason.
 * @param {{outward?: boolean, agentType?: unknown}} request an ask (lib/timed-ask.mjs answerAsk)
 * @param {Record<string, string | undefined>} env process environment (the store path)
 * @returns {string} the note; '' when the request keeps the timed allow (not outward, or no max runs)
 */
export function clickOnlyNote(request, env) {
  if (request.outward !== true) return '';
  if (request.agentType === CLICK_ONLY_AGENT_TYPE) return OWN_NOTE;
  const running = anyRunning(CLICK_ONLY_AGENT_TYPE, env);
  if (running === 'yes') return RUNNING_NOTE;
  return running === 'unusable' ? UNREADABLE_NOTE : '';
}

/**
 * @param {{outward?: boolean, agentType?: unknown}} request an ask (lib/timed-ask.mjs answerAsk)
 * @param {Record<string, string | undefined>} env process environment (the store path)
 * @returns {boolean} true when only a click on Allow lets the request run (see clickOnlyNote)
 */
export const needsClickedAllow = (request, env) => clickOnlyNote(request, env) !== '';
