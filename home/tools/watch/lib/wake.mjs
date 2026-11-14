// Decides which action lines wake the caller of `--exit-on-event`. Exports: createWakeGate(options) -> (text, cls) => void.
// A line wakes when its class is wanted, it is not the retry of an event just counted, it is past the first `skip` events, and (for
// API_ERROR and STALL, when delayMs > 0) the session shows no reply of its own for delayMs afterwards; then `wake(text, cls)` is
// called once and every later line is dropped.
// Invariants: pure apart from the clock and timer it is given; one event is held at a time (another api-error or stall that arrives
// meanwhile is dropped, the held one decides; any other wanted class wakes at once); a dropped event (the session recovered) leaves
// the gate open for the next one.
// Skipped events are counted when they arrive, not after the delay: a backup watcher started with `skip: 1` must skip the first
// failure even when the primary watcher's wake (and the lead's work after it) lands inside a delay window, or it would miss the second.
import { DELAYED_CLASSES } from './events.mjs';

const RETRY_WINDOW_MS = 60_000; // the same class again within this long is a retry of the same failure, not a new event

/**
 * @param {object} options
 * @param {Set<string>} options.wanted internal classes that count (events.mjs internalClasses)
 * @param {number} options.skip how many counted events to ignore first
 * @param {number} options.delayMs how long an API_ERROR or STALL is held to see whether the session recovers (0 = no hold)
 * @param {() => number} options.replies how many replies of its own the watched session has written so far
 * @param {() => number} options.now clock in epoch milliseconds
 * @param {(text: string, cls: string) => void} options.wake called once, with the line that wakes the caller
 * @returns {(text: string, cls: string) => void} the sink for action lines
 */
export function createWakeGate({ wanted, skip, delayMs, replies, now, wake }) {
  const lastCountedAt = new Map();
  let counted = 0;
  let woke = false;
  let holding = false;

  const isRetry = (cls) => lastCountedAt.has(cls) && now() - lastCountedAt.get(cls) < RETRY_WINDOW_MS;
  const fire = (text, cls) => { woke = true; wake(text, cls); };
  const hold = (text, cls) => {
    holding = true;
    const repliesAtEvent = replies();
    setTimeout(() => {
      holding = false;
      if (woke) return;
      if (replies() === repliesAtEvent) fire(text, cls);
      else lastCountedAt.delete(cls); // recovered: the next failure is a new event, not a retry of this one
    }, delayMs);
  };

  return (text, cls) => {
    if (woke || !wanted.has(cls) || isRetry(cls)) return;
    const delayed = delayMs > 0 && DELAYED_CLASSES.has(cls);
    if (holding && delayed) return;
    lastCountedAt.set(cls, now());
    counted += 1;
    if (counted <= skip) return;
    if (delayed) hold(text, cls);
    else fire(text, cls);
  };
}
