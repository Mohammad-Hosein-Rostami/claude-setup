#!/usr/bin/env node
// CLI of the finish estimate: reads the `## Work items` table of a STATUS.md and the working time in the session transcripts, and
// prints the one committed finish time of the job (line 1, `Finish:`, the median; the 85% and 95% clocks beside it), what it covers and excludes, whether it held or moved and why,
// the track record and any Check lines (paste the block as-is; never quote a number of your own). Beside a job over about 6 h of
// work it names the limit resets last seen for this terminal's account (CLAUDE_ACCOUNT, lib/limits-store.mjs). Clock times use the system time
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
// prints. A store that cannot be updated records nothing and says so on stderr. A recorded run at the real clock also writes the
// status line's cache entry from its result (lib/segment-cache.mjs), so the CLI and the status line show the same time.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isSessionId } from '../../hooks/lib/session-store.mjs';
import { UsageError, estimateFile } from './lib/from-files.mjs';
import { latestSample, readLimits } from './lib/limits-store.mjs';
import { formatEstimate, formatRefusal } from './lib/report.mjs';
import { cacheDir, writeEntry } from './lib/segment-cache.mjs';
import { resultSegment } from './lib/segment-text.mjs';
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
  // A run pointed at another store or transcript folder is a probe: its result must not reach the real status-line cache.
  const isProbe = values['state-dir'] !== undefined || values.projects !== undefined;
  return { path: positionals[0], isProbe, options: { now: values.now, stateDir: store, projectsDir: values.projects, sessionId, record: store !== null } };
}

/**
 * Stores this run's segment in the status line's cache, as statusline-cache.mjs would, so a commitment the CLI made or moved is what
 * the status line shows at once (else the two could differ until the next refresh, up to RECOMPUTE_AFTER_MS). A failed write only
 * leaves the old entry, which the next refresh replaces.
 */
function storeSegment(statusPath, file, result, startedAt) {
  const { kind, text, highMs, progress, numbers } = resultSegment(result);
  writeEntry(cacheDir(), statusPath, { path: statusPath, kind, text, highMs, progress, numbers, mtimeMs: file.mtimeMs, size: file.size, computedAt: Date.now(), refreshStartedAt: startedAt });
}

/** The file's stat, or null when it cannot be read: estimateFile then reports the file as a usage error (exit 2). */
function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null; // e.g. missing or no permission: the estimate's own read names the problem
  }
}

function main(argv) {
  const { path, options, isProbe } = readOptions(argv);
  const startedAt = Date.now();
  const file = statOrNull(path); // before the estimate, as the refresh does: an edit meanwhile reads as a change
  const { result, inputs } = estimateFile(path, Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)));
  // Only a recorded run at the real clock on the real folders: a --now run describes another instant, a probe another table.
  if (inputs.recorded && options.now === undefined && !isProbe && file?.isFile()) storeSegment(resolve(path), file, result, startedAt);
  // Not only a busy lock: an unusable or over-cap store file records nothing too (table-store names an over-cap file on its own line).
  if (inputs.busy) process.stderr.write('estimate: this run recorded nothing (the store was busy or a store file could not be used)\n');
  if (result.state === 'refused') {
    process.stderr.write(`${formatRefusal(result)}\n`);
    return EXIT_REFUSED;
  }
  // Only the real clock's run names the limits: a --now run or a probe describes another instant or table.
  const limits = options.now === undefined && !isProbe ? latestSample(readLimits(process.env.CLAUDE_ACCOUNT)) : null;
  process.stdout.write(`${formatEstimate(result, { limits })}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  process.stderr.write(`estimate: ${err.message}\n`);
  process.exitCode = EXIT_USAGE;
}
