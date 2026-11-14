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
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { computeEstimate } from './lib/compute.mjs';
import { INSTANT_FORMAT, parseInstant, parseWorkItems } from './lib/items.mjs';
import { limitWindows, projectSlug, resolveTranscriptDir } from './lib/limits.mjs';
import { formatEstimate, formatRefusal } from './lib/report.mjs';

const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const USAGE = 'usage: estimate.mjs <STATUS.md> [--transcripts <dir>] [--now <iso>]';
const VALUE_FLAGS = ['--transcripts', '--now'];
const READ_CHUNK_BYTES = 1 << 20;
const MISSING_CODES = ['ENOENT', 'ENOTDIR'];

class UsageError extends Error {}

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

/** True for a folder, false when it does not exist; any other failure (permissions) is an error, not "no transcripts". */
const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch (err) {
    if (MISSING_CODES.includes(err.code)) return false;
    throw new UsageError(`cannot read ${path}: ${err.message}`);
  }
};

function readStatus(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${err.message}`);
  }
}

/** The lines of a file, read in chunks so a transcript of any size is never held whole. Errors become UsageError. */
function* fileLines(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let carry = '';
    for (let n = readSync(fd, chunk, 0, READ_CHUNK_BYTES, null); n > 0; n = readSync(fd, chunk, 0, READ_CHUNK_BYTES, null)) {
      const parts = (carry + decoder.write(chunk.subarray(0, n))).split('\n');
      carry = parts.pop();
      yield* parts;
    }
    yield carry + decoder.end();
  } catch (err) {
    throw new UsageError(`cannot read transcript ${path}: ${err.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The transcript folder to read: the explicit one (must exist), else the project's by slug; names of its top-level `.jsonl` files. */
function transcriptFiles(explicitDir) {
  const root = join(homedir(), '.claude', 'projects');
  if (explicitDir !== undefined && !isDirectory(explicitDir)) throw new UsageError(`--transcripts ${explicitDir} is not a folder that exists`);
  const dir = explicitDir ?? resolveTranscriptDir(process.cwd(), root, isDirectory, homedir()) ?? join(root, projectSlug(process.cwd()));
  if (!isDirectory(dir)) return { dir, names: [] };
  try {
    return { dir, names: readdirSync(dir).filter((name) => name.endsWith('.jsonl')) };
  } catch (err) {
    throw new UsageError(`cannot read transcripts ${dir}: ${err.message}`);
  }
}

function main(argv) {
  const { path, transcripts, now } = parseArgs(argv);
  const nowMs = now === undefined ? Date.now() : parseInstant(now);
  if (nowMs === null) throw new UsageError(`--now "${now}" is not a real ISO 8601 instant; accepted: ${INSTANT_FORMAT}`);
  const stamp = now ?? new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z');
  const { items, problems } = parseWorkItems(readStatus(path));
  if (problems.length > 0) throw new UsageError(problems.map((p) => `${path}:${p.line}: ${p.reason}`).join('\n'));

  const { dir, names } = transcriptFiles(transcripts);
  const windows = limitWindows(names.map((name) => fileLines(join(dir, name))));
  const result = computeEstimate(items, windows, nowMs);
  if (result.refused) {
    process.stderr.write(`${formatRefusal(result)}\n`);
    return EXIT_REFUSED;
  }
  console.log(formatEstimate(result, { path, now: stamp, transcriptDir: dir, transcriptCount: names.length }));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  process.stderr.write(`estimate: ${err.message}\n`);
  process.exitCode = EXIT_USAGE;
}
