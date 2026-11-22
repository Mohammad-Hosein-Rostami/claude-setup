#!/usr/bin/env node
// Purpose: the lead's per-round review check, as one deterministic command: it reads the review-tier JSON and the lens reports of a round
//   (each pinned by the sha256 the lead recorded), applies the rules of lib/verdict.mjs, writes the prior file for the next round and
//   prints the verdict and the one action to take (`next:`). It replaces the checks of the retired review workflow script.
// Usage: verdict.mjs --tier <json> --tier-sha256 <hex> (--report <file> --report-sha256 <hex>)... [--prior <file> --prior-sha256 <hex>]
//        [--road <json> --road-sha256 <hex> --lane <name>] [--waived] [--drop <id>]... [--judged <file> --judged-sha256 <hex>]
//        --write-prior <file> [--json]
//   Reports are given in the order of the tier's `reviews` (`--waived`: of `waivable.reviews`). A hash flag pairs with the file flag of the same
//   position. `--lane` without `--road` only names the lane in the prior file.
// Prints: verdict: clean|findings <ids>|incomplete: <why>; round: <n>; follow-up: <ids>|none; [dropped:] [debug:] [owner:];
//   prior-file: <path> sha256 <hex> (none while incomplete); next: land|fix <ids>|rerun <lens #>|re-spec <classes>.
// Exit codes: 0 clean, 1 findings, 2 usage or hash, 3 incomplete, 4 owner question (a security finding was asked to be dropped).
// Exports: run(argv).
// Invariants: every file is opened once, checked as a regular file under MAX_PRIOR_BYTES, hashed from the bytes read and compared with its
//   flag before it is used (P3, P6). The prior file is created new only (exit 2 when the path exists, F4). Report text is never printed.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UsageError } from '../git-tidy/lib/git.mjs';
import { LANE_NAME } from '../road/lib/road-file.mjs';
import { MAX_PRIOR_BYTES } from './lib/prior.mjs';
import { parsePriorFile, parseReport } from './lib/report-lines.mjs';
import { decide, priorFileText } from './lib/verdict.mjs';

const EXIT = { clean: 0, findings: 1, usage: 2, incomplete: 3, owner: 4 };
const USAGE = 'usage: verdict.mjs --tier <json> --tier-sha256 <hex> (--report <file> --report-sha256 <hex>)... [--prior <file> --prior-sha256 <hex>] [--road <json> --road-sha256 <hex> --lane <name>] [--waived] [--drop <id>]... [--judged <file> --judged-sha256 <hex>] --write-prior <file> [--json]';
const VALUE_FLAGS = new Set(['--tier', '--tier-sha256', '--report', '--report-sha256', '--prior', '--prior-sha256', '--road', '--road-sha256', '--lane', '--drop', '--judged', '--judged-sha256', '--write-prior']);
const REPEATED_FLAGS = new Set(['--report', '--report-sha256', '--drop']);
const BOOLEAN_FLAGS = new Set(['--waived', '--json']);
const SHA256 = /^[0-9a-f]{64}$/;
const FINDING_ID = /^[A-Za-z][\w.-]{0,31}$/;
const PRINCIPLE_ID = /^[PF]\d{1,3}$/;
const RULING_LINE = /^ruling: ([A-Za-z][\w.-]{0,31}) (real|not-real)\b/;
const CONTROL_CHARS = /[\u0000-\u001f]/;

/** Reads the flags into `{name: value | [values]}`. */
function parseArguments(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (BOOLEAN_FLAGS.has(flag)) flags[flag] = true;
    else if (VALUE_FLAGS.has(flag) && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
      const value = argv[(index += 1)];
      if (CONTROL_CHARS.test(value)) throw new UsageError(`${flag} holds a control character`);
      if (REPEATED_FLAGS.has(flag)) (flags[flag] ??= []).push(value);
      else if (flags[flag] === undefined) flags[flag] = value;
      else throw new UsageError(`${flag} is given twice`);
    } else throw new UsageError(`${flag} is not a flag or needs a value. ${USAGE}`);
  }
  return flags;
}

/** Opens `path` once, refuses anything but a regular file under the cap, and returns its bytes when their sha256 is `recorded`. */
function readPinned(flag, path, recorded) {
  if (!SHA256.test(String(recorded).toLowerCase())) throw new UsageError(`${flag} needs the sha256 recorded for ${path} (64 hex digits) right after it`);
  let descriptor = null;
  let bytes;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer (it is refused below); it changes nothing for a regular file.
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('not a regular file');
    if (stats.size > MAX_PRIOR_BYTES) throw new Error(`over ${MAX_PRIOR_BYTES} bytes`);
    bytes = readFileSync(descriptor);
  } catch (error) {
    throw new UsageError(`cannot read ${flag} ${path}: ${error.message}`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== String(recorded).toLowerCase()) throw new UsageError(`${path} is not the file that was recorded: its sha256 is ${sha256}, the flag after ${flag} says ${recorded} (a changed file, or the hashes in another order than the files)`);
  return { text: bytes.toString('utf8'), sha256 };
}

/** The values of a file flag and its hash flag, which must come the same number of times. */
function pairs(flags, fileFlag, hashFlag) {
  const files = [flags[fileFlag] ?? []].flat();
  const hashes = [flags[hashFlag] ?? []].flat();
  if (files.length !== hashes.length) throw new UsageError(`${fileFlag} was given ${files.length} times and ${hashFlag} ${hashes.length} times: each file needs its recorded sha256`);
  return files.map((path, at) => ({ path, recorded: hashes[at] }));
}

/** The ids of the lane's questions in the road (`principles`), or an error naming what is missing. */
function roadIdsOf(flags) {
  if (flags['--road'] === undefined) return null;
  if (flags['--lane'] === undefined) throw new UsageError('--road needs --lane <name>');
  const { text } = readPinned('--road', flags['--road'], flags['--road-sha256']);
  let road;
  try {
    road = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--road is not JSON: ${error.message}`);
  }
  const lane = (Array.isArray(road?.steps) ? road.steps : []).flatMap((step) => (Array.isArray(step?.lanes) ? step.lanes : [])).find((candidate) => candidate?.name === flags['--lane']);
  if (lane === undefined) throw new UsageError(`--road has no lane named ${flags['--lane']}`);
  const ids = (Array.isArray(lane.principles) ? lane.principles : []).map((principle) => principle?.id);
  if (!ids.every((id) => PRINCIPLE_ID.test(String(id)))) throw new UsageError(`the principles of lane ${flags['--lane']} hold an id that is not P<n> or F<n>`);
  return ids;
}

/** The judge's rulings as `Map<id, 'real'|'not-real'>`. */
function rulingsOf(flags) {
  const rulings = new Map();
  if (flags['--judged'] === undefined) return rulings;
  const { text } = readPinned('--judged', flags['--judged'], flags['--judged-sha256']);
  for (const line of text.split('\n')) {
    const match = RULING_LINE.exec(line.trim());
    if (match !== null) rulings.set(match[1], match[2]);
  }
  return rulings;
}

/** Reads and checks every input the flags name: the tier, the reports, the prior file, the road ids, the rulings. */
function readInputs(flags) {
  for (const flag of ['--tier', '--write-prior']) if (flags[flag] === undefined) throw new UsageError(`${flag} is required. ${USAGE}`);
  if (flags['--lane'] !== undefined && !LANE_NAME.test(flags['--lane'])) throw new UsageError(`--lane must match ${LANE_NAME}`);
  const drops = flags['--drop'] ?? [];
  if (!drops.every((id) => FINDING_ID.test(id))) throw new UsageError('--drop takes a finding id');
  const target = resolve(flags['--write-prior']);
  if (lstatSyncOrNull(target) !== null) throw new UsageError(`--write-prior ${target} exists: a prior file is written once, to a new path`);
  let tier;
  try {
    tier = JSON.parse(readPinned('--tier', flags['--tier'], flags['--tier-sha256']).text);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`--tier is not JSON: ${error.message}`);
  }
  if (tier === null || typeof tier !== 'object' || !/^[0-9a-f]{40}$/i.test(String(tier.tip))) throw new UsageError('the tier JSON has no full 40-character `tip`');
  const reports = pairs(flags, '--report', '--report-sha256').map(({ path, recorded }) => parseReport(readPinned('--report', path, recorded).text));
  const [priorFile] = pairs(flags, '--prior', '--prior-sha256');
  if (flags['--prior'] === undefined && flags['--prior-sha256'] !== undefined) throw new UsageError('--prior-sha256 needs --prior');
  const prior = priorFile === undefined ? null : readPrior(priorFile);
  return { tier, reports, prior, roadIds: roadIdsOf(flags), rulings: rulingsOf(flags), drops, target, lane: flags['--lane'] ?? null };
}

/** The prior file as `{round, lane, tip, report, sha256}`. */
function readPrior({ path, recorded }) {
  const { text, sha256 } = readPinned('--prior', path, recorded);
  const parsed = parsePriorFile(text);
  if (parsed === null) throw new UsageError(`--prior ${path} is no prior file of this tool (its first two lines are the header and \`round: <n>\`)`);
  return { ...parsed, sha256 };
}

function lstatSyncOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new UsageError(`cannot look at ${path}: ${error.message}`);
  }
}

/** Writes the prior file to a new path (`wx`: never over another file) and returns the hash of what was written. */
function writePrior(target, text) {
  try {
    writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new UsageError(`cannot write --write-prior ${target}: ${error.message}`);
  }
  return createHash('sha256').update(text).digest('hex');
}

/** The printed lines of a result, in the order of the contract. */
function textOf(result, priorFile) {
  const lines = [`verdict: ${result.verdict === 'clean' ? 'clean' : result.verdict === 'findings' ? `findings ${result.ids.join(',')}` : `incomplete: ${result.why}`}`, `round: ${result.round}`, `follow-up: ${result.followUp.length > 0 ? result.followUp.join(',') : 'none'}`];
  if (result.dropped.length > 0) lines.push(`dropped: ${result.dropped.join(',')}`);
  if (result.debug !== null) lines.push(`debug: ${result.debug}`);
  if (result.owner.length > 0) lines.push(`owner: ${result.owner.join(',')}`);
  lines.push(priorFile === null ? 'prior-file: none' : `prior-file: ${priorFile.path} sha256 ${priorFile.sha256}`, `next: ${result.next}`);
  return lines.join('\n');
}

/**
 * Runs the tool.
 * @param {string[]} argv the flags
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function run(argv) {
  try {
    const flags = parseArguments(argv);
    const inputs = readInputs(flags);
    const result = decide({ tier: inputs.tier, waived: flags['--waived'] === true, reports: inputs.reports, prior: inputs.prior, lane: inputs.lane, roadIds: inputs.roadIds, drops: inputs.drops, rulings: inputs.rulings });
    const priorFile = result.verdict === 'incomplete' ? null : { path: inputs.target, sha256: writePrior(inputs.target, priorFileText(result, inputs.lane, String(inputs.tier.tip).toLowerCase())) };
    const code = result.owner.length > 0 ? EXIT.owner : EXIT[result.verdict];
    const printed = flags['--json'] === true
      ? JSON.stringify({ verdict: result.verdict, ids: result.ids, why: result.why, round: result.round, followUp: result.followUp, dropped: result.dropped, debug: result.debug, owner: result.owner, priorFile, next: result.next })
      : textOf(result, priorFile);
    return { code, stdout: `${printed}\n`, stderr: '' };
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return { code: EXIT.usage, stdout: '', stderr: `verdict: ${error.message}\n` };
  }
}

// realpathSync: the owner's ~/.claude is a symlink to home/, so argv[1] is not the file's own path (tests/main-module-guard.test.mjs)
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
