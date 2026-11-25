// A child process for long-run-account-switch-lock.test.mjs (not a test file): it stands in for drive() between driver.mjs's
// acquireLock and its first driver.json write. It takes the run lock with the repo's own acquireLock, prints `locked`, waits for a
// line on stdin, then writes driver.json as the driver's live writer does, beats every second and prints `live`.
// Usage: node long-run-account-switch-lock-driver.mjs <state root> <run id>. It exits when its stdin closes (the test ended).
import { hostname } from 'node:os';
import { acquireLock, readJson, runPaths, writeJson } from '../home/tools/long-run/lib/run-store.mjs';

const BEAT_MS = 1000; // well inside the stale-beat window that driverAlive allows

const [root, runId] = process.argv.slice(2);
const paths = runPaths(root, runId);
acquireLock(paths);
process.stdout.write('locked\n');
process.stdin.once('data', () => {
  const base = { ...(readJson(paths.driver) ?? {}), pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), status: 'running', hold: null };
  const beat = () => writeJson(paths.driver, { ...base, beatAt: new Date().toISOString(), live: {} });
  beat();
  setInterval(beat, BEAT_MS);
  process.stdout.write('live\n');
});
process.stdin.on('end', () => process.exit(0));
