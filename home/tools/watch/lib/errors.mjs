// Reports the watcher's own problems on stdout instead of dying silently.
// Exports: createErrorReporter({ now, emit, record }) -> { report(label, error) }, shortReason(error).
// Output: `WATCH_ERROR <label> <short reason>`. The same label + reason is printed at most once per RATE_LIMIT_MS, so a bad
// line repeated every poll cannot flood the notifications. The reason is one line, control characters removed, 100 chars.
const RATE_LIMIT_MS = 60_000;
const REASON_CHARS = 100;

/** @param {unknown} error an Error or any thrown value @returns {string} one short printable line */
export function shortReason(error) {
  const text = error instanceof Error ? error.message : String(error);
  return Array.from(text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim()).slice(0, REASON_CHARS).join('') || 'unknown error';
}

/**
 * @param {{ now: () => number, emit: (text: string) => void, record: (label: string, text: string) => void }} sinks
 */
export function createErrorReporter({ now, emit, record }) {
  const lastShown = new Map();
  return {
    report(label, error) {
      const reason = shortReason(error);
      const key = `${label} ${reason}`;
      const at = now();
      if (lastShown.has(key) && at - lastShown.get(key) < RATE_LIMIT_MS) return;
      lastShown.set(key, at);
      emit(`WATCH_ERROR ${label} ${reason}`);
      record(label, `${new Date(at).toISOString()} WATCH_ERROR ${reason}`);
    },
  };
}
