// A child process for long-run-lock-rule.test.mjs (not a test file): a driver's view of one run's lock, through the repo's own
// run-store. It prints `{"ready":true,"pid":<pid>}`, then answers one line of stdin at a time with one line of JSON:
//   `alive`        -> {"alive":<driverAlive>}
//   `take <at ms>` -> waits until the clock reads <at> (0: at once; so several takers start together), then acquireLock:
//                     {"took":true}, {"busy":"<RunBusy message>"} or {"error":"<message>"}
// Usage: node [--import tests/no-ps-hook.mjs] long-run-lock-rule-taker.mjs <state root> <run id>. It exits when its stdin closes.
import { createInterface } from 'node:readline';
import { RunBusy, acquireLock, driverAlive, runPaths } from '../home/tools/long-run/lib/run-store.mjs';

const [root, runId] = process.argv.slice(2);
const paths = runPaths(root, runId);
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function take(at) {
  while (Date.now() < at); // a busy wait: a timer would add its own spread to the start
  try {
    acquireLock(paths);
    return { took: true };
  } catch (error) {
    return error instanceof RunBusy ? { busy: error.message } : { error: String(error?.stack ?? error) };
  }
}

const answers = { alive: () => ({ alive: driverAlive(paths) }), take: (at) => take(Number(at)) };

say({ ready: true, pid: process.pid });
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const [command, argument] = line.split(' ');
    say(Object.hasOwn(answers, command) ? answers[command](argument) : { error: `unknown command: ${command}` });
  })
  .on('close', () => process.exit(0));
