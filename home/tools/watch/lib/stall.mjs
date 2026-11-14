// Stall detector: "nothing was written for N minutes", reported once per silence, then RESUMED when writing starts again.
// Exports: createStallDetector(stallMs) -> { check(lastWriteMs, nowMs, idle) -> { type: 'STALL' | 'IDLE' | 'RESUMED', idleMs } | undefined,
// stalled: boolean }.
// `idle` says the silence is a finished turn waiting for its owner: the report is then IDLE instead of STALL. An IDLE that was
// reported and later stops being idle without a new write (the session process ended) is reported once more, as a STALL.
// Invariants: pure (the caller supplies both times, so tests inject a clock); an unknown last write (no file yet) never stalls.

/**
 * @param {number} stallMs how long without a write counts as a stall
 * @returns {{ check: (lastWriteMs: number | undefined, nowMs: number, idle?: boolean) => ({ type: 'STALL' | 'IDLE' | 'RESUMED', idleMs: number } | undefined), readonly stalled: boolean }}
 */
export function createStallDetector(stallMs) {
  let stalledAt; // the last-write time that was current when the STALL or IDLE was reported
  let reportedIdle = false;
  return {
    get stalled() { return stalledAt !== undefined; },
    check(lastWriteMs, nowMs, idle = false) {
      if (lastWriteMs === undefined) return undefined;
      const idleMs = nowMs - lastWriteMs;
      if (stalledAt === undefined) {
        if (idleMs <= stallMs) return undefined;
        stalledAt = lastWriteMs;
        reportedIdle = idle;
        return { type: idle ? 'IDLE' : 'STALL', idleMs };
      }
      if (lastWriteMs <= stalledAt) {
        if (!reportedIdle || idle) return undefined;
        reportedIdle = false;
        return { type: 'STALL', idleMs };
      }
      stalledAt = undefined;
      return { type: 'RESUMED', idleMs };
    },
  };
}
