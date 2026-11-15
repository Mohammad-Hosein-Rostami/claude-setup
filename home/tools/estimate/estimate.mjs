#!/usr/bin/env node
// CLI of the finish estimate: reads the `## Work items` table of a STATUS.md plus the project's lead transcripts and prints
// when the whole job is finished as a local clock range (line 1, `Finish:`), then what it includes, excludes and assumes
// and how earlier estimates did (paste the block as-is; never quote a number of your own). Clock times use the system time
// zone (`TZ` is honoured).
// Usage: estimate.mjs <STATUS.md> [--transcripts <dir>] [--now <iso>] [--log-dir <dir>]
//        --transcripts  folder of the lead transcripts (*.jsonl, not subagents); default: ~/.claude/projects/<slug of cwd>,
//                       walking up to the nearest parent whose folder exists (never the home folder); a missing or
//                       unreadable path given here is exit 2
//        --now          the "computed" stamp and the latest allowed started/done (default: the real clock); a --now run
//                       neither reads nor writes the calibration log unless --log-dir is given (tests, replays)
//        --log-dir      folder of the calibration log (default ~/.claude/state/estimate-log)
// Exit codes: 0 finish printed; 2 usage or parse error (the file, a cell or a flag is wrong; the message names the row
// line); 3 refused (`No finish time:` and `What to do:`: fewer than 5 done items with started, done and evidence, a done row
// without started, a time later than --now, a done item with no working time, or a closing phase already longer than every
// closing measured). Nothing that looks like an estimate is printed on 2 or 3; transcript content is never printed.
// Invariants: logic lives in lib/ (pure); this file only parses arguments, reads files, prints and writes its log. The log
// (lib/estimate-log.mjs) gets the earlier entries scored and one new entry per printed range; a refusal writes nothing.
import { resolve } from 'node:path';
import { applyFactors, calibrationFactors, logEntry, scoreEntries, trackRecord } from './lib/calibration.mjs';
import { logFile, readLog, writeLog } from './lib/estimate-log.mjs';
import { UsageError, estimateFile } from './lib/from-files.mjs';
import { formatEstimate, formatRefusal, printedBounds } from './lib/report.mjs';

const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const USAGE = 'usage: estimate.mjs <STATUS.md> [--transcripts <dir>] [--now <iso>] [--log-dir <dir>]';
const VALUE_FLAGS = ['--transcripts', '--now', '--log-dir'];

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) positional.push(arg);
    else if (VALUE_FLAGS.includes(arg) && i + 1 < argv.length) flags[arg] = argv[(i += 1)];
    else throw new UsageError(`unknown or incomplete flag ${arg}`);
  }
  if (positional.length !== 1) throw new UsageError(USAGE);
  return { path: positional[0], transcripts: flags['--transcripts'], now: flags['--now'], logDir: flags['--log-dir'] };
}

/** Prints the block scaled by the log's factors, then writes the log back: earlier entries scored, this range appended. */
function printLogged(result, inputs, items, { statusPath, logDir }) {
  const entries = scoreEntries(readLog(statusPath, logDir), items, result.computedAt);
  const factors = calibrationFactors(entries);
  const shown = result.finish === undefined ? result : applyFactors(result, factors);
  console.log(formatEstimate(shown, { ...inputs, calibration: { record: trackRecord(entries), factors } }));
  const kept = result.finish === undefined ? entries : [...entries, logEntry(statusPath, shown, items, printedBounds(shown))];
  if (!writeLog(statusPath, kept, logDir)) process.stderr.write(`estimate: could not write the calibration log ${logFile(statusPath, logDir)}\n`);
}

function main(argv) {
  const { path, transcripts, now, logDir } = parseArgs(argv);
  const { result, inputs, items } = estimateFile(path, { transcripts, now, cwd: process.cwd() });
  if (result.refused) {
    process.stderr.write(`${formatRefusal(result)}\n`);
    return EXIT_REFUSED;
  }
  if (now !== undefined && logDir === undefined) console.log(formatEstimate(result, inputs));
  else printLogged(result, inputs, items, { statusPath: resolve(path), logDir });
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  process.stderr.write(`estimate: ${err.message}\n`);
  process.exitCode = EXIT_USAGE;
}
