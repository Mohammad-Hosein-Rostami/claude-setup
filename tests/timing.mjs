// Shared helper for tests that guard a speed target ("decides in under 500 ms").
// Exports: fastestMs(work, attempts) -> the shortest wall time, in ms, of `attempts` independent runs of `work`.
// Why the fastest: the suite runs ~15 test files in parallel, so a single run can be slowed by the machine (a descheduled
// process, a GC pause) without the code under test being slower. The code can only be as fast as its best run, so a target
// that holds for the fastest of a few runs still fails when the code itself is slow. The threshold stays the caller's.
// `work` must be pure and repeatable: every run does the same job from scratch.
const DEFAULT_ATTEMPTS = 3;

/**
 * @param {() => void} work the job being timed (synchronous)
 * @param {number} [attempts] how many times to run it
 * @returns {number} the shortest run, in milliseconds
 */
export function fastestMs(work, attempts = DEFAULT_ATTEMPTS) {
  let fastest = Infinity;
  for (let run = 0; run < attempts; run += 1) {
    const started = performance.now();
    work();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}
