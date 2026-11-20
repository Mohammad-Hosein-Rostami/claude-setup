#!/usr/bin/env node
// CLI of `review-tier`: reads a git range and says which reviews to run together (agent, model, effort, lens, brief, plan).
// Usage: review-tier.mjs [<range>] [--landing] [--delta <reviewed-sha> --prior <findings-file>] [--lane-classes <file>] [--add-class <c>]...
//                        [--base <b>] [--json]
//   <range>          `a..b` or `a...b`; default `<base>...HEAD`, base the first of main, master, develop
//   --landing        the last review before the base moves: adds the Opus max lens, the auditor and a mutation plan
//   --delta <sha>    a fix round: review only what changed since that reviewed sha (a rebased lane: only patches the reviewed set lacks),
//                    with the set of the whole lane: the tool reads the lane range (<base>...HEAD) itself and always gives the landing
//                    set, so the round is never lighter than the lane's review. Needs --prior. An empty delta is exit 2
//   --prior <file>   with --delta: the review report of the previous round, as its reviewers wrote it. The tool prints its sha256 and the
//                    number of blocking and should-fix findings in it; every brief tells the reviewer to check the hash and to verify each
//                    finding itself. The path is pasted into every brief: one that is not plain, or a file that cannot be read, is exit 2
//   --lane-classes   the `--json` of the previous round: adds the classes it holds (a class the lead added by hand, a class of a line an
//                    earlier fix removed); it can only raise the set
//   --add-class <c>  raise only: adds that class's full set and plan (unknown class: exit 2)
// Exit codes: 0 printed, 1 git failed, 2 usage (bad range, unknown sha or class, bad flag).
// Invariants: read-only on the repository; the only write is one line in the log (REVIEW_TIER_LOG overrides its path).
//   Line texts are never printed or logged (see tiers.mjs), and neither is the text of the --prior file (lib/prior.mjs).
//   Every git call runs with GIT_NO_REPLACE_OBJECTS=1: the commits and files read are the real ones, never a replace ref's.
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { UsageError, gitText } from '../git-tidy/lib/git.mjs';
import { CLASS_TIER, LOCK_TAG, RACE_TAG } from './tiers.mjs';
import { baseOf, checkRange, newFileReader, readDelta, readRange, requiredReadingFor } from './lib/diff.mjs';
import { appendLog } from './lib/log.mjs';
import { readPrior } from './lib/prior.mjs';
import { buildReport, formatJson, formatText, logRecord } from './lib/report.mjs';

const EXIT_GIT_FAILED = 1;
const EXIT_USAGE = 2;
const MAX_LANE_FILE_BYTES = 4 << 20;
// The --prior path is pasted into every brief, so it is agent input: a name with a newline or a sentence in it could give the reviewer orders.
// Only a plain absolute path passes: the rule of SAFE_PATH in home/workflows, plus `~` for Windows short names (RUNNER~1).
const PLAIN_PATH = /^(?:[A-Za-z]:[\\/]|\/)[\w@+=.,~/\\-]+$/;
const MAX_ECHOED_PATH_CHARS = 120; // a refused path is quoted in the error, cut to this length
const KNOWN_NAMES = new Set([...Object.keys(CLASS_TIER), LOCK_TAG, RACE_TAG]);
const USAGE = 'usage: review-tier.mjs [<range>] [--landing] [--delta <sha> --prior <file>] [--lane-classes <file>] [--add-class <c>]... [--base <b>] [--json]';

function valueOf(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value. ${USAGE}`);
  return value;
}

function parseArgs(argv) {
  const options = { range: null, landing: false, json: false, delta: null, prior: null, laneClasses: null, addClasses: [], base: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--landing') options.landing = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--delta') options.delta = valueOf(argv, i++, arg);
    else if (arg === '--prior') options.prior = resolve(valueOf(argv, i++, arg));
    else if (arg === '--lane-classes') options.laneClasses = valueOf(argv, i++, arg);
    else if (arg === '--base') options.base = valueOf(argv, i++, arg);
    else if (arg === '--add-class') options.addClasses.push(valueOf(argv, i++, arg));
    else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}. ${USAGE}`);
    else if (options.range === null) options.range = arg;
    else throw new UsageError(`one range only. ${USAGE}`);
  }
  for (const name of options.addClasses) {
    if (!Object.hasOwn(CLASS_TIER, name)) throw new UsageError(`unknown class "${name}" for --add-class (one of: ${Object.keys(CLASS_TIER).join(', ')})`);
  }
  if (options.delta !== null && options.range !== null) throw new UsageError(`--delta names its own range: give a range or --delta, not both. ${USAGE}`);
  if (options.delta !== null && options.prior === null) throw new UsageError(`--delta needs --prior <findings-file>: a fix round names the review report of the round before (a lane's first review reads the whole range). ${USAGE}`);
  if (options.prior !== null) {
    if (options.delta === null) throw new UsageError(`--prior belongs to a --delta round. ${USAGE}`);
    if (!PLAIN_PATH.test(options.prior)) throw new UsageError(`--prior must be a plain path (letters, digits and _@+=.,~/- only: no spaces, quotes or newlines; copy the report to a path without them), because it is pasted into every brief: ${JSON.stringify(options.prior.slice(0, MAX_ECHOED_PATH_CHARS))}`);
  }
  return options;
}

/**
 * A previous round's JSON: `fileClasses` (path -> known class names) and `classes` (its class list, which holds what the lead added by
 * hand); anything else in the file is ignored.
 */
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
  const fileClasses = {};
  for (const [path, names] of Object.entries(map)) {
    if (!Array.isArray(names)) throw new UsageError(`--lane-classes ${file}: fileClasses["${path}"] must be a list`);
    fileClasses[path] = names.filter((name) => KNOWN_NAMES.has(name));
  }
  return { fileClasses, classes: Array.isArray(parsed.classes) ? parsed.classes.filter((name) => Object.hasOwn(CLASS_TIER, name)) : [] };
}

/**
 * What a fix round reads: the delta since the reviewed sha, plus the whole lane range (lane base to HEAD), from which the report works
 * out the lane's own classes, so no flag the caller leaves out can make the set lighter than the lane's.
 */
function deltaRound(top, options) {
  const base = baseOf(top, options.base);
  const { range, files, reviewedSha } = readDelta(top, base, options.delta);
  return { range, files, deltaOf: reviewedSha, laneFiles: readRange(top, `${base}...HEAD`), requiredReading: requiredReadingFor(top, files), endRevision: 'HEAD' };
}

function wholeRange(top, options) {
  const range = options.range ?? `${baseOf(top, options.base)}...HEAD`;
  const endRevision = checkRange(top, range);
  return { range, files: readRange(top, range), deltaOf: null, laneFiles: null, requiredReading: [], endRevision };
}

function run(options) {
  const top = gitText(process.cwd(), ['rev-parse', '--show-toplevel']);
  const earlier = options.laneClasses === null ? null : readLaneClasses(options.laneClasses);
  const isDelta = options.delta !== null;
  const { endRevision, ...read } = isDelta ? deltaRound(top, options) : wholeRange(top, options);
  const report = buildReport({
    ...read, readNewFile: newFileReader(top, endRevision), addClasses: options.addClasses, prior: options.prior === null ? null : readPrior(options.prior),
    // A fix round is the last review of its lines before land, and the tool cannot know which flags the lane's first review had: it
    // always gets the landing set, the strongest the lane can have had.
    landing: options.landing || isDelta, laneClasses: earlier?.fileClasses ?? null, earlierClasses: earlier?.classes ?? [],
  });
  console.log(options.json ? formatJson(report) : formatText(report));
  const problem = appendLog(logRecord(report, basename(top), new Date()));
  if (problem !== null) console.error(`review-tier: ${problem}`);
}

function main(argv) {
  // A replace ref (`git replace <fix commit> <harmless commit>`) shows in no diff and would swap what every git call below reads.
  process.env.GIT_NO_REPLACE_OBJECTS = '1';
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
