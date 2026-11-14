// The action-only filter of the old watch.sh, applied to verbose events: which events are worth waking someone for.
// Exports: actionFor(event) -> { cls, text } | undefined; ACTION_CLASSES.
// Classes: OWNER (a real owner prompt), COMPACT, STOP_HOOK (Stop hook feedback), ERROR (tool error, API error, rate or usage limit).
// Invariants: the alert words are matched on the whole verbose line, in the same order and with the same regex as watch.sh
// (the alert rule runs before the OWNER rule, so a prompt that contains an alert word prints as the raw line, as it did).
// Cut lengths are watch.sh's: 200 characters of the line, 200 of an owner prompt.

export const ACTION_CLASSES = ['OWNER', 'COMPACT', 'STOP_HOOK', 'ERROR'];

const ALERT_WORDS = / COMPACT| ERROR| API_ERROR| LIMIT| RATE|Stop hook feedback|usage limit/;
const STOP_HOOK = /Stop hook feedback/;
const NOT_OWNER = /cross-session-message|task-notification|This session is being continued|Stop hook/;
const LINE_CHARS = 200;

/**
 * @param {{ kind: string, line: string, owner?: boolean, promptText?: string }} event a verbose event from classify.mjs
 * @returns {{ cls: string, text: string } | undefined} the action line (without the session label), or undefined for a routine event
 */
export function actionFor(event) {
  if (ALERT_WORDS.test(event.line)) {
    const cls = event.kind === 'COMPACT' ? 'COMPACT' : STOP_HOOK.test(event.line) ? 'STOP_HOOK' : 'ERROR';
    return { cls, text: Array.from(event.line).slice(0, LINE_CHARS).join('') };
  }
  if (event.kind === 'PROMPT' && event.owner && !NOT_OWNER.test(event.line)) return { cls: 'OWNER', text: `OWNER ${event.promptText}` };
  return undefined;
}
