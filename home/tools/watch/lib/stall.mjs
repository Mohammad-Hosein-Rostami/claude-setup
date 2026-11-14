// Stall detector: "nothing was written for N minutes", reported once per stall, then RESUMED when writing starts again.
// Exports: createStallDetector(stallMs) -> { check(lastWriteMs, nowMs) -> { type: 'STALL' | 'RESUMED', idleMs } | undefined }.
// Invariants: pure (the caller supplies both times, so tests inject a clock); an unknown last write (no file yet) never stalls.

/**
 * @param {number} stallMs how long without a write counts as a stall
 * @returns {{ check: (lastWriteMs: number | undefined, nowMs: number) => ({ type: 'STALL' | 'RESUMED', idleMs: number } | undefined) }}
 */
export function createStallDetector(stallMs) {
  let stalledAt; // the last-write time that was current when the STALL was reported
  return {
    check(lastWriteMs, nowMs) {
      if (lastWriteMs === undefined) return undefined;
      const idleMs = nowMs - lastWriteMs;
      if (stalledAt === undefined) {
        if (idleMs <= stallMs) return undefined;
        stalledAt = lastWriteMs;
        return { type: 'STALL', idleMs };
      }
      if (lastWriteMs <= stalledAt) return undefined;
      stalledAt = undefined;
      return { type: 'RESUMED', idleMs };
    },
  };
}
