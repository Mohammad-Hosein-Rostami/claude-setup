#!/usr/bin/env node
// CLI of the finish estimate: reads the `## Work items` table of a STATUS.md and the working time in the session transcripts, and
// prints the one committed finish time of the job (line 1, `Finish:`), what it covers and excludes, whether it held or moved and why,
// the track record and any Check lines (paste the block as-is; never quote a number of your own). Clock times use the system time
// zone (`TZ` is honoured). The estimator design and the exact lines are in README.md.
// Usage: estimate.mjs <STATUS.md> [--session <id>] [--now <iso>] [--state-dir <dir>] [--projects <dir>]
//        --session    the session whose transcripts count, besides the sessions already linked to the table (default
//                     $CLAUDE_CODE_SESSION_ID)
//        --now        the instant to estimate at and the latest allowed started/done (default: the clock); a --now run without
//                     --state-dir neither reads nor writes the store (tests, replays)
//        --state-dir  the estimate store (default ~/.claude/state/estimate)
//        --projects   Claude Code's projects folder (default ~/.claude/projects)
// Exit codes: 0 finish, all done or handed over printed; 2 usage or table problem (the message names the line; nothing that looks
// like an estimate is printed); 3 refused (`No finish time:` and `What to do:` on stderr, never a clock time).
// Invariants: the logic lives in lib/ (from-files.mjs estimateFile, shared with the status line); this file parses arguments and
// prints. A busy store records nothing and says so on stderr.
import { parseArgs } from 'node:util';
import { isSessionId } from '../../hooks/lib/session-store.mjs';
import { UsageError, estimateFile } from './lib/from-files.mjs';
import { formatEstimate, formatRefusal } from './lib/report.mjs';
import { stateDir } from './lib/table-store.mjs';

const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const USAGE = 'usage: estimate.mjs <STATUS.md> [--session <id>] [--now <iso>] [--state-dir <dir>] [--projects <dir>]';
const OPTIONS = { session: { type: 'string' }, now: { type: 'string' }, 'state-dir': { type: 'string' }, projects: { type: 'string' } };

function readOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError(`${error.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new UsageError(USAGE);
  if (values.session !== undefined && !isSessionId(values.session)) throw new UsageError(`--session "${values.session}" is not a session id`);
  const sessionId = values.session ?? (isSessionId(process.env.CLAUDE_CODE_SESSION_ID) ? process.env.CLAUDE_CODE_SESSION_ID : undefined);
  const store = values['state-dir'] ?? (values.now === undefined ? stateDir() : null);
  return { path: positionals[0], options: { now: values.now, stateDir: store, projectsDir: values.projects, sessionId, record: store !== null } };
}

function main(argv) {
  const { path, options } = readOptions(argv);
  const { result, inputs } = estimateFile(path, Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)));
  if (inputs.busy) process.stderr.write('estimate: the store was busy; this run recorded nothing\n');
  if (result.state === 'refused') {
    process.stderr.write(`${formatRefusal(result)}\n`);
    return EXIT_REFUSED;
  }
  process.stdout.write(`${formatEstimate(result)}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  process.stderr.write(`estimate: ${err.message}\n`);
  process.exitCode = EXIT_USAGE;
}
