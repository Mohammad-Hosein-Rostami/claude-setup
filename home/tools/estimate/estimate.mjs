#!/usr/bin/env node
// CLI of the work estimate: reads the `## Work items` table of a STATUS.md plus the project's lead transcripts and prints
// a range of agent-hours, running time and calendar days (paste the output as-is; never quote a number of your own).
// Usage: estimate.mjs <STATUS.md> [--transcripts <dir>] [--now <iso>]
//        --transcripts  folder of the lead transcripts (*.jsonl, not subagents); default: ~/.claude/projects/<slug of cwd>,
//                       walking up to the nearest parent whose folder exists (never the home folder); a missing or
//                       unreadable path given here is exit 2
//        --now          the "computed" stamp and the latest allowed started/done (default: the real clock)
// Exit codes: 0 estimate printed; 2 usage or parse error (the file, a cell or a flag is wrong; the message names the row
// line); 3 refused (the table reads fine but cannot support a number: fewer than 5 done items with started, done and
// evidence, a done row without started, a time later than --now, a done item with no working time). Nothing that looks
// like an estimate is printed on 2 or 3; transcript content is never printed.
// Invariants: logic lives in lib/ (pure); this file only parses arguments, reads files and prints. It never writes.
import { UsageError, estimateFile } from './lib/from-files.mjs';
import { formatEstimate, formatRefusal } from './lib/report.mjs';

const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const USAGE = 'usage: estimate.mjs <STATUS.md> [--transcripts <dir>] [--now <iso>]';
const VALUE_FLAGS = ['--transcripts', '--now'];

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
  return { path: positional[0], transcripts: flags['--transcripts'], now: flags['--now'] };
}

function main(argv) {
  const { path, transcripts, now } = parseArgs(argv);
  const { result, inputs } = estimateFile(path, { transcripts, now, cwd: process.cwd() });
  if (result.refused) {
    process.stderr.write(`${formatRefusal(result)}\n`);
    return EXIT_REFUSED;
  }
  console.log(formatEstimate(result, inputs));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  process.stderr.write(`estimate: ${err.message}\n`);
  process.exitCode = EXIT_USAGE;
}
