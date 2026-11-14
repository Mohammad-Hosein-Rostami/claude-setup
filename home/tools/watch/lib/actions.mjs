// The action-only filter of the old watch.sh, applied to verbose events: which events are worth waking someone for.
// Exports: actionFor(event) -> { cls, text } | undefined; ACTION_CLASSES.
// Classes: OWNER (a real owner prompt), COMPACT, STOP_HOOK (Stop hook feedback), ERROR (tool error, rate or usage limit words),
// API_ERROR, LIMIT and LIMIT_RESET (the three events of classify.mjs that come from isApiErrorMessage entries).
// The event kind decides first: a PROMPT is never an ERROR/COMPACT alert (an owner prompt that quotes "ERROR" is still just an
// OWNER line), and a meta, sidechain or compaction-summary prompt is never anything, whatever words its text contains. The one
// exception is harness "Stop hook feedback", which arrives as a meta prompt and is recognised by its text starting that way.
// The alert words for the other kinds are watch.sh's regex, matched on the whole verbose line; cut lengths are 200 characters.

export const ACTION_CLASSES = ['OWNER', 'COMPACT', 'STOP_HOOK', 'ERROR', 'API_ERROR', 'LIMIT', 'LIMIT_RESET'];
const ALWAYS_ACTION_KINDS = new Set(['API_ERROR', 'LIMIT', 'LIMIT_RESET']);

const ALERT_WORDS = / COMPACT| ERROR| API_ERROR| LIMIT| RATE|Stop hook feedback|usage limit/;
const STOP_HOOK_START = /^Stop hook feedback/;
const NOT_OWNER = /cross-session-message|task-notification|This session is being continued|Stop hook/;
const LINE_CHARS = 200;

const cut = (text) => Array.from(text).slice(0, LINE_CHARS).join('');

function promptAction(event) {
  if (STOP_HOOK_START.test(event.promptText)) return { cls: 'STOP_HOOK', text: cut(event.line) };
  if (!event.owner || NOT_OWNER.test(event.line)) return undefined;
  return { cls: 'OWNER', text: `OWNER ${event.promptText}` };
}

/**
 * @param {{ kind: string, line: string, owner?: boolean, promptText?: string }} event a verbose event from classify.mjs
 * @returns {{ cls: string, text: string } | undefined} the action line (without the session label), or undefined for a routine event
 */
export function actionFor(event) {
  if (event.kind === 'PROMPT') return promptAction(event);
  if (ALWAYS_ACTION_KINDS.has(event.kind)) return { cls: event.kind, text: event.line };
  if (!ALERT_WORDS.test(event.line)) return undefined;
  const cls = event.kind === 'COMPACT' ? 'COMPACT' : /Stop hook feedback/.test(event.line) ? 'STOP_HOOK' : 'ERROR';
  return { cls, text: cut(event.line) };
}
