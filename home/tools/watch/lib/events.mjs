// The event classes `--exit-on-event` can wake on. Exports: EXIT_CLASS_NAMES, DEFAULT_EXIT_CLASSES, WATCH_ERROR_CLASS,
// internalClasses(names) -> Set.
// Each name the owner types maps to the internal classes the watcher tags its output lines with (actions.mjs gives OWNER, ERROR,
// COMPACT, API_ERROR, LIMIT and LIMIT_RESET; the watcher adds GUARD, STALL and WATCH_ERROR). `limit` covers both a limit window
// starting and ending. `compact` is the only class that is not on by default. SESSION_END, RESUMED, STOP_HOOK and MODEL MISMATCH
// never wake: they are not in this table on purpose.

export const WATCH_ERROR_CLASS = 'WATCH_ERROR';

const CLASSES_BY_NAME = new Map([
  ['owner', ['OWNER']],
  ['error', ['ERROR']],
  ['limit', ['LIMIT', 'LIMIT_RESET']],
  ['api-error', ['API_ERROR']],
  ['guard', ['GUARD']],
  ['stall', ['STALL']],
  ['watch-error', [WATCH_ERROR_CLASS]],
  ['compact', ['COMPACT']],
]);

export const EXIT_CLASS_NAMES = [...CLASSES_BY_NAME.keys()];
export const DEFAULT_EXIT_CLASSES = EXIT_CLASS_NAMES.filter((name) => name !== 'compact');

/** @param {string[]} names validated names from EXIT_CLASS_NAMES @returns {Set<string>} the internal classes that wake */
export const internalClasses = (names) => new Set(names.flatMap((name) => CLASSES_BY_NAME.get(name)));
