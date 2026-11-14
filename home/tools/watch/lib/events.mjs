// The event classes of the watcher and the names `--exit-on-event` accepts.
// Exports: EVENT_CLASS (the tags every action line carries), WATCH_ERROR_CLASS, EXIT_CLASS_NAMES, DEFAULT_EXIT_CLASSES,
// DELAYED_CLASSES, internalClasses(names) -> Set.
// Each name the owner types maps to the internal classes the watcher tags its output lines with (actions.mjs gives OWNER, ERROR,
// COMPACT, STOP_HOOK, API_ERROR, LIMIT and LIMIT_RESET; watcher.mjs adds MODEL_MISMATCH, STALL, SESSION_END and RESUMED; watch.mjs
// adds GUARD and WATCH_ERROR). Default: owner, error, limit, api-error, guard, stall, watch-error, session-end. Opt-in: compact,
// stop-hook, model-mismatch, limit-reset, idle. RESUMED is not a class: it only follows a STALL or an IDLE, and those already woke the lead.
// IDLE (opt-in `idle`): the same silence as a STALL, but the session finished its turn and waits for its owner (nothing was in flight).
// It is not delayed: there is no recovery to wait for, the owner's next prompt is what ends it.
// ALERT_TEXT is an alert-word line that is not a failed tool result (plain mode prints it, no class wakes on it).
// DELAYED_CLASSES are the wake events that `--delay-sec` holds back, because the session can recover on its own.
// Code refers to the tags through EVENT_CLASS, so a misspelt tag is an `undefined` the tests catch, not a class that never wakes.

export const EVENT_CLASS = Object.freeze({
  OWNER: 'OWNER',
  ERROR: 'ERROR',
  ALERT_TEXT: 'ALERT_TEXT',
  COMPACT: 'COMPACT',
  STOP_HOOK: 'STOP_HOOK',
  API_ERROR: 'API_ERROR',
  LIMIT: 'LIMIT',
  LIMIT_RESET: 'LIMIT_RESET',
  MODEL_MISMATCH: 'MODEL_MISMATCH',
  GUARD: 'GUARD',
  STALL: 'STALL',
  IDLE: 'IDLE',
  RESUMED: 'RESUMED',
  SESSION_END: 'SESSION_END',
  WATCH_ERROR: 'WATCH_ERROR',
});

export const WATCH_ERROR_CLASS = EVENT_CLASS.WATCH_ERROR;

const DEFAULT_CLASSES = [
  ['owner', EVENT_CLASS.OWNER],
  ['error', EVENT_CLASS.ERROR],
  ['limit', EVENT_CLASS.LIMIT],
  ['api-error', EVENT_CLASS.API_ERROR],
  ['guard', EVENT_CLASS.GUARD],
  ['stall', EVENT_CLASS.STALL],
  ['watch-error', EVENT_CLASS.WATCH_ERROR],
  ['session-end', EVENT_CLASS.SESSION_END],
];

const OPT_IN_CLASSES = [
  ['compact', EVENT_CLASS.COMPACT],
  ['stop-hook', EVENT_CLASS.STOP_HOOK],
  ['model-mismatch', EVENT_CLASS.MODEL_MISMATCH],
  ['limit-reset', EVENT_CLASS.LIMIT_RESET],
  ['idle', EVENT_CLASS.IDLE],
];

const CLASS_BY_NAME = new Map([...DEFAULT_CLASSES, ...OPT_IN_CLASSES]);

export const EXIT_CLASS_NAMES = [...CLASS_BY_NAME.keys()];
export const DEFAULT_EXIT_CLASSES = DEFAULT_CLASSES.map(([name]) => name);
export const DELAYED_CLASSES = new Set([EVENT_CLASS.API_ERROR, EVENT_CLASS.STALL]);

/** @param {string[]} names validated names from EXIT_CLASS_NAMES @returns {Set<string>} the internal classes that wake */
export const internalClasses = (names) => new Set(names.map((name) => CLASS_BY_NAME.get(name)));
