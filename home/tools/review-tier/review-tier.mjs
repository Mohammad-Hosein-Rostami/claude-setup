#!/usr/bin/env node
// CLI of `review-tier`: reads a git range and says which reviews to run together (agent, model, effort, lens, brief, plan).
// Usage: review-tier.mjs [<range>] [--landing] [--delta <reviewed-sha>] [--lane-classes <file>] [--add-class <c>]...
//                        [--base <b>] [--json]
//   <range>          `a..b` or `a...b`; default `<base>...HEAD`, base the first of main, master, develop
//   --landing        the last review before the base moves: adds the Opus max lens, the auditor and a mutation plan
//   --delta <sha>    review only what changed since that reviewed sha (a rebased lane: only patches the reviewed set lacks)
//   --lane-classes   the `--json` of the previous round (its fileClasses): each file keeps the classes it had in the lane
//   --add-class <c>  raise only: adds that class's full set and plan (unknown class: exit 2)
// Exit codes: 0 printed, 1 git failed, 2 usage (bad range, unknown sha or class, bad flag).
// Invariants: read-only on the repository; the only write is one line in the log (REVIEW_TIER_LOG overrides its path).
//   Line texts are never printed or logged (see tiers.mjs).
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { UsageError, gitText } from '../git-tidy/lib/git.mjs';
import { CLASS_TIER, LOCK_TAG, RACE_TAG } from './tiers.mjs';
import { baseOf, checkRange, newFileReader, readDelta, readRange, requiredReadingFor } from './lib/diff.mjs';
import { appendLog } from './lib/log.mjs';
import { buildReport, formatJson, formatText, logRecord } from './lib/report.mjs';

const EXIT_GIT_FAILED = 1;
const EXIT_USAGE = 2;
const MAX_LANE_FILE_BYTES = 4 << 20;
const KNOWN_NAMES = new Set([...Object.keys(CLASS_TIER), LOCK_TAG, RACE_TAG]);
const USAGE = 'usage: review-tier.mjs [<range>] [--landing] [--delta <sha>] [--lane-classes <file>] [--add-class <c>]... [--base <b>] [--json]';

function valueOf(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value. ${USAGE}`);
  return value;
}

function parseArgs(argv) {
  const options = { range: null, landing: false, json: false, delta: null, laneClasses: null, addClasses: [], base: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--landing') options.landing = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--delta') options.delta = valueOf(argv, i++, arg);
    else if (arg === '--lane-classes') options.laneClasses = valueOf(argv, i++, arg);
    else if (arg === '--base') options.base = valueOf(argv, i++, arg);
    else if (arg === '--add-class') options.addClasses.push(valueOf(argv, i++, arg));
    else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}. ${USAGE}`);
    else if (options.range === null) options.range = arg;
    else throw new UsageError(`one range only. ${USAGE}`);
  }
  for (const name of options.addClasses) {
    if (!(name in CLASS_TIER)) throw new UsageError(`unknown class "${name}" for --add-class (one of: ${Object.keys(CLASS_TIER).join(', ')})`);
  }
  if (options.delta !== null && options.range !== null) throw new UsageError(`--delta names its own range: give a range or --delta, not both. ${USAGE}`);
  return options;
}

/** The `fileClasses` of a previous round's JSON: path -> known class names; anything else in the file is ignored. */
function readLaneClasses(file) {
  let parsed;
  try {
    if (statSync(file).size > MAX_LANE_FILE_BYTES) throw new Error('file is over 4 MiB');
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read --lane-classes ${file}: ${error.message}`);
  }
  const map = parsed?.fileClasses;
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new UsageError(`--lane-classes ${file}: no "fileClasses" object (use the --json of the previous round)`);
  const lane = {};
  for (const [path, names] of Object.entries(map)) {
    if (!Array.isArray(names)) throw new UsageError(`--lane-classes ${file}: fileClasses["${path}"] must be a list`);
    lane[path] = names.filter((name) => KNOWN_NAMES.has(name));
  }
  return lane;
}

function run(options) {
  const top = gitText(process.cwd(), ['rev-parse', '--show-toplevel']);
  const laneClasses = options.laneClasses === null ? null : readLaneClasses(options.laneClasses);
  let range;
  let files;
  let requiredReading = [];
  let endRevision = 'HEAD';
  if (options.delta !== null) {
    ({ range, files } = readDelta(top, baseOf(top, options.base), options.delta));
    requiredReading = requiredReadingFor(top, files);
  } else {
    range = options.range ?? `${baseOf(top, options.base)}...HEAD`;
    endRevision = checkRange(top, range);
    files = readRange(top, range);
  }
  const report = buildReport({
    files, readNewFile: newFileReader(top, endRevision), landing: options.landing, addClasses: options.addClasses,
    laneClasses, range, deltaOf: options.delta, requiredReading,
  });
  console.log(options.json ? formatJson(report) : formatText(report));
  const problem = appendLog(logRecord(report, basename(top), new Date()));
  if (problem !== null) console.error(`review-tier: ${problem}`);
}

function main(argv) {
  try {
    run(parseArgs(argv));
    return 0;
  } catch (error) {
    // 1 means git failed, 2 a mistake of the caller; nothing else is allowed to become Node's default exit code.
    const usage = error instanceof UsageError;
    console.error(`review-tier: ${usage ? '' : 'git failed: '}${error.message}`);
    return usage ? EXIT_USAGE : EXIT_GIT_FAILED;
  }
}

process.exitCode = main(process.argv.slice(2));
