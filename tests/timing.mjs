// Shared helper for tests that guard a speed target ("decides in under 500 ms").
// Exports: fastestMs(work, attempts) -> the shortest wall time, in ms, of `attempts` independent runs of `work`;
// fastestCpuMs(work, attempts) -> the same with this process's CPU time (user + system) instead of wall time.
// Why the fastest: the suite runs ~15 test files in parallel, so a single run can be slowed by the machine (a descheduled
// process, a GC pause) without the code under test being slower. The code can only be as fast as its best run, so a target
// that holds for the fastest of a few runs still fails when the code itself is slow. The threshold stays the caller's.
// `work` must be pure and repeatable: every run does the same job from scratch.
// CPU time for in-process CPU-bound work (a regex that must stay linear): a busy machine that deschedules the process for
// every run, as a doctor run beside other agents does, cannot push it over the target. It does not count child processes,
// so a job that waits on `git` is timed with fastestMs.
const DEFAULT_ATTEMPTS = 3;

const cpuNowMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

function fastestBy(now, work, attempts) {
  let fastest = Infinity;
  for (let run = 0; run < attempts; run += 1) {
    const started = now();
    work();
    fastest = Math.min(fastest, now() - started);
  }
  return fastest;
}

/**
 * @param {() => void} work the job being timed (synchronous)
 * @param {number} [attempts] how many times to run it
 * @returns {number} the shortest run, in wall-clock milliseconds
 */
export const fastestMs = (work, attempts = DEFAULT_ATTEMPTS) => fastestBy(() => performance.now(), work, attempts);

/** Like fastestMs, in CPU milliseconds of this process (user + system). */
export const fastestCpuMs = (work, attempts = DEFAULT_ATTEMPTS) => fastestBy(cpuNowMs, work, attempts);
