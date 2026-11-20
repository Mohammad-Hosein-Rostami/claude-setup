#!/usr/bin/env node
// CLI of `review-tier`: reads a git range and says which reviews to run together (agent, model, effort, lens, brief, plan).
// Usage: review-tier.mjs [<range>] [--landing] [--add-class <c>]... [--lane-classes <names>] [--base <b>] [--json]      (a first review)
//        review-tier.mjs --delta <reviewed-sha> --base <base-sha> (--prior <findings-file> --prior-sha256 <hex>)... --lane-classes <names> [--add-class <c>]... [--json]   (a fix round)
//   <range>          `a..b` or `a...b`; default `<base sha>...HEAD`, the base being the one of main, master, develop that is a local branch.
//                    Each side is read like the base: HEAD, a local branch or a full sha (with an optional ~N or ^N), never a tag or
//                    another ref of that name; any other side is exit 2. The printed range holds the resolved shas
//   --base <b>       a first review: where the lane starts, a local branch (read as refs/heads/<b>, never a tag of that name; a name
//                    that starts with refs/ is exit 2) or a full sha; needed when more than one of main, master, develop exists.
//                    A fix round: required, the full 40-character sha the lane now starts from (an ancestor of HEAD; after a rebase,
//                    the tip it was rebased onto). No branch is read there, so moving one changes nothing
//   --landing        the last review before the base moves: adds the Opus max lens, the auditor and a mutation plan
//   --delta <sha>    a fix round: the full 40-character sha the last review read, from the lead's record (a short sha or a name is
//                    exit 2). It reads the tree diff <sha>..HEAD; when the sha is no ancestor of HEAD (a rebased or rebuilt lane) it reads
//                    the whole lane <base>..HEAD and what changed in the lane's files since <sha>. The set is the whole lane's (the tool
//                    reads <base>..HEAD itself and always gives the landing set), so the round is never lighter than the lane's
//                    review. Needs --base, --prior and --lane-classes. An empty delta is exit 2
//   --prior <file>   with --delta: a review report of the previous round, as its reviewer wrote it; repeat it for each report (reviewer,
//                    security). The tool prints its sha256, the number of blocking and should-fix findings in it and their ids; every
//                    brief tells the reviewer to check the hash and to verify each finding itself. The path is pasted into every brief:
//                    one that is not plain, or a file that cannot be read, is exit 2
//   --prior-sha256   one after each --prior, in the same order: the sha256 the lead recorded when the reviewer returned that report.
//                    A missing one, or a file whose hash differs (it was edited after the review), is exit 2 naming the file
//   --lane-classes   the class names of the round before, comma-separated (security,logic,docs: the `fix round:` line that round
//                    printed carries them, its JSON has them as laneClasses). They only raise the set: a class the lead added by hand,
//                    a class of a line an earlier fix removed. No file is read. Required with --delta; an unknown name is exit 2
//   --add-class <c>  raise only: adds that class's full set and plan (unknown class: exit 2)
// Exit codes: 0 printed, 1 git failed, 2 usage (bad range, unknown sha or class, bad flag, a repository whose history can be altered).
// Invariants: read-only on the repository; the only write is one line in the log (REVIEW_TIER_LOG overrides its path).
//   Line texts are never printed or logged (see tiers.mjs), and neither is the text of the --prior file (lib/prior.mjs).
//   A repository with a graft file, a replace ref or a shallow history is refused before anything is read (exit 2); git also runs with
//   GIT_NO_REPLACE_OBJECTS=1 and a GIT_GRAFT_FILE that cannot exist, and without the variables that move the shallow file or the replace refs.
import { basename, join, resolve } from 'node:path';
import { UsageError, gitFlag, gitText } from '../git-tidy/lib/git.mjs';
import { CLASS_TIER, LOCK_TAG, RACE_TAG } from './tiers.mjs';
import { MAX_READING, newFileReader, readDelta, readRange, requiredReadingFor } from './lib/diff.mjs';
import { baseOf, checkRange, recordedSha, refuseAlteredHistory } from './lib/revisions.mjs';
import { appendLog } from './lib/log.mjs';
import { readPriors } from './lib/prior.mjs';
import { buildReport, formatJson, formatText, logRecord } from './lib/report.mjs';

const EXIT_GIT_FAILED = 1;
const EXIT_USAGE = 2;
// The --prior path is pasted into every brief, so it is agent input: a name with a newline or a sentence in it could give the reviewer orders.
// Only a plain absolute path passes: the rule of SAFE_PATH in home/workflows, plus `~` for Windows short names (RUNNER~1).
const PLAIN_PATH = /^(?:[A-Za-z]:[\\/]|\/)[\w@+=.,~/\\-]+$/;
const MAX_ECHOED_PATH_CHARS = 120; // a refused path is quoted in the error, cut to this length
const LANE_NAMES = [...Object.keys(CLASS_TIER), LOCK_TAG, RACE_TAG]; // an array: `includes` has no prototype names to match
const USAGE = 'usage: review-tier.mjs [<range>] [--landing] [--add-class <c>]... [--base <b>] [--json], or for a fix round: review-tier.mjs --delta <reviewed-sha> --base <base-sha> (--prior <file> --prior-sha256 <hex>)... --lane-classes <names> [--add-class <c>]... [--json]';
// History the environment could move: git-tidy's runGit already drops the variables that choose the repository and its objects.
const HISTORY_VARIABLES = ['GIT_SHALLOW_FILE', 'GIT_REPLACE_REF_BASE'];
const SHA256 = /^[0-9a-f]{64}$/;

function valueOf(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value. ${USAGE}`);
  return value;
}

function parseArgs(argv) {
  const options = { range: null, landing: false, json: false, delta: null, priors: [], priorHashes: [], laneClasses: null, addClasses: [], base: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--landing') options.landing = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--delta') options.delta = valueOf(argv, i++, arg);
    else if (arg === '--prior') options.priors.push(resolve(valueOf(argv, i++, arg)));
    else if (arg === '--prior-sha256') options.priorHashes.push(valueOf(argv, i++, arg).toLowerCase());
    else if (arg === '--lane-classes') options.laneClasses = laneNames(valueOf(argv, i++, arg));
    else if (arg === '--base') options.base = valueOf(argv, i++, arg);
    else if (arg === '--add-class') options.addClasses.push(valueOf(argv, i++, arg));
    else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}. ${USAGE}`);
    else if (options.range === null) options.range = arg;
    else throw new UsageError(`one range only. ${USAGE}`);
  }
  for (const name of options.addClasses) {
    if (!Object.hasOwn(CLASS_TIER, name)) throw new UsageError(`unknown class "${name}" for --add-class (one of: ${Object.keys(CLASS_TIER).join(', ')})`);
  }
  checkFixRound(options);
  return options;
}

/** The names `--lane-classes` got: known class and tag names, at least one. Nothing else is read: a path or a JSON text is an unknown name. */
function laneNames(value) {
  const names = value.split(',').map((name) => name.trim()).filter((name) => name !== '');
  const unknown = names.find((name) => !LANE_NAMES.includes(name));
  if (names.length === 0 || unknown !== undefined) throw new UsageError(`--lane-classes takes the class names of the round before, comma-separated (--lane-classes security,logic,docs: the \`fix round:\` line that round printed carries them; no file is read): ${unknown === undefined ? 'no name given' : `unknown name ${JSON.stringify(unknown.slice(0, MAX_ECHOED_PATH_CHARS))}`} (one of: ${LANE_NAMES.join(', ')})`);
  return names;
}

/** The contract of a fix round: `--delta` names its own range, the lane's start, the report or reports of the round before with their recorded hashes, and that round's classes. */
function checkFixRound({ delta, range, base, priors, priorHashes, laneClasses }) {
  if (delta === null) {
    if (priors.length + priorHashes.length > 0) throw new UsageError(`--prior and --prior-sha256 belong to a --delta round. ${USAGE}`);
    return;
  }
  if (range !== null) throw new UsageError(`--delta names its own range: give a range or --delta, not both. ${USAGE}`);
  if (priors.length === 0) throw new UsageError(`--delta needs --prior <findings-file>: a fix round names the review report of the round before (a lane's first review reads the whole range). ${USAGE}`);
  if (base === null) throw new UsageError(`--delta needs --base <base-sha>: the full sha the lane now starts from (the \`fix round:\` line of the round before carries it; after a rebase pass the tip it was rebased onto, \`git merge-base <base branch> HEAD\`). No branch is looked up in a fix round. ${USAGE}`);
  if (laneClasses === null) throw new UsageError(`--delta needs --lane-classes <names>: the class names of the round before, comma-separated (the \`fix round:\` line that round printed carries them, its --json has them as laneClasses), the only record of a class whose lines a fix removed. When that record is lost, run a whole-range review instead (no --delta). ${USAGE}`);
  for (const path of priors) {
    if (!PLAIN_PATH.test(path)) throw new UsageError(`--prior must be a plain path (letters, digits and _@+=.,~/- only: no spaces, quotes or newlines; copy the report to a path without them), because it is pasted into every brief: ${JSON.stringify(path.slice(0, MAX_ECHOED_PATH_CHARS))}`);
  }
  if (new Set(priors).size !== priors.length) throw new UsageError('the same --prior file is named twice: name each report of the round before once');
  // A report with no recorded hash is one nobody can tell from a copy the fix's writer edited (security S1).
  if (priorHashes.length !== priors.length) throw new UsageError(`each --prior needs its own --prior-sha256 <hex> after it, in the same order (the sha256 the lead recorded when the reviewer returned that report): ${priors.length} --prior, ${priorHashes.length} --prior-sha256${priorHashes.length < priors.length ? `; none for ${priors[priorHashes.length]}` : ''}`);
  priorHashes.forEach((hash, index) => { if (!SHA256.test(hash)) throw new UsageError(`--prior-sha256 for ${priors[index]} is not a sha256 (64 hex digits)`); });
}

/**
 * What a fix round reads: the delta since the reviewed commit, plus the whole lane (lane start to HEAD), from which the report works out
 * the lane's own classes and the size of its plan, so no flag the caller leaves out can make the set lighter than the lane's. Both commits
 * are full shas from the lead's record: nothing is looked up by name, so no ref made or moved since the review changes what is read.
 */
function deltaRound(top, options) {
  const [base, reviewed] = [recordedSha(top, options.base, '--base'), recordedSha(top, options.delta, '--delta')];
  if (!gitFlag(top, ['merge-base', '--is-ancestor', base, 'HEAD'])) throw new UsageError(`--base ${base} is no ancestor of HEAD: pass the commit the lane now starts from (after a rebase, the tip it was rebased onto: \`git merge-base <base branch> HEAD\`)`);
  const { range, files, reading } = readDelta(top, base, reviewed);
  // On a rewritten lane the first things to read are what the rewrite changed.
  const requiredReading = [...new Set([...reading, ...requiredReadingFor(top, files)])].slice(0, MAX_READING);
  return { range, files, deltaOf: reviewed, laneFiles: readRange(top, `${base}..HEAD`), requiredReading, endRevision: 'HEAD', base, tip: gitText(top, ['rev-parse', '--verify', 'HEAD^{commit}']) };
}

function wholeRange(top, options) {
  const { range, endRevision, base, tip } = checkRange(top, options.range ?? `${baseOf(top, options.base)}...HEAD`);
  return { range, files: readRange(top, range), deltaOf: null, laneFiles: null, requiredReading: [], endRevision, base, tip };
}

function run(options) {
  const top = gitText(process.cwd(), ['rev-parse', '--show-toplevel']);
  refuseAlteredHistory(top);
  const isDelta = options.delta !== null;
  const { endRevision, ...read } = isDelta ? deltaRound(top, options) : wholeRange(top, options);
  const report = buildReport({
    ...read, readNewFile: newFileReader(top, endRevision), addClasses: options.addClasses,
    prior: isDelta ? readPriors(options.priors.map((path, index) => ({ path, sha256: options.priorHashes[index] }))) : null,
    // A fix round is the last review of its lines before land, and the tool cannot know which flags the lane's first review had: it
    // always gets the landing set, the strongest the lane can have had.
    landing: options.landing || isDelta, laneNames: options.laneClasses ?? [],
  });
  console.log(options.json ? formatJson(report) : formatText(report));
  const problem = appendLog(logRecord(report, basename(top), new Date()));
  if (problem !== null) console.error(`review-tier: ${problem}`);
}

function main(argv) {
  // A replace ref or a graft shows in no diff and would swap what every git call below reads. Both are refused (refuseAlteredHistory) and
  // switched off as well: the graft file is set to a path below the node binary, a file, so nobody can create it.
  process.env.GIT_NO_REPLACE_OBJECTS = '1';
  process.env.GIT_GRAFT_FILE = join(process.execPath, 'no-grafts');
  for (const name of HISTORY_VARIABLES) delete process.env[name];
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
