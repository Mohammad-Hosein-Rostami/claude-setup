#!/usr/bin/env node
// CLI of the work estimate: reads the `## Work items` table of a STATUS.md plus the project's lead transcripts and prints
// a range of agent-hours, running time and calendar days (paste the output as-is; never quote a number of your own).
// Usage: estimate.mjs <STATUS.md> [--transcripts <dir>] [--now <iso>]
//        --transcripts  folder of the lead transcripts (*.jsonl, not subagents); default: ~/.claude/projects/<slug of cwd>,
//                       walking up to the nearest parent whose folder exists
//        --now          the "computed" stamp (tests and reproducible output only)
// Exit codes: 0 estimate printed, 2 usage or parse error (message names the row line), 3 refused: fewer than 5 done items
// with started, done and evidence (no estimate number is printed).
// Invariants: logic lives in lib/ (pure); this file only parses arguments, reads files and prints. It never writes.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeEstimate } from './lib/compute.mjs';
import { parseWorkItems } from './lib/items.mjs';
import { limitWindows, projectSlug, resolveTranscriptDir } from './lib/limits.mjs';
import { formatEstimate, formatRefusal } from './lib/report.mjs';

const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const USAGE = 'usage: estimate.mjs <STATUS.md> [--transcripts <dir>] [--now <iso>]';
const NOW_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const VALUE_FLAGS = ['--transcripts', '--now'];

class UsageError extends Error {}

function fail(message) {
  process.stderr.write(`estimate: ${message}\n`);
  process.exit(EXIT_USAGE);
}

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

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // a missing folder is the answer "no transcripts", not an error
  }
};

function readStatus(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${err.message}`);
  }
}

/** The transcript folder to read and the texts of its top-level `.jsonl` files (subagent folders are not entered). */
function loadTranscripts(explicitDir) {
  const root = join(homedir(), '.claude', 'projects');
  const dir = explicitDir ?? resolveTranscriptDir(process.cwd(), root, isDirectory) ?? join(root, projectSlug(process.cwd()));
  if (!isDirectory(dir)) return { dir, texts: [] };
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  return { dir, texts: files.map((name) => readFileSync(join(dir, name), 'utf8')) };
}

function main(argv) {
  const { path, transcripts, now } = parseArgs(argv);
  if (now !== undefined && (!NOW_FORMAT.test(now) || Number.isNaN(Date.parse(now)))) throw new UsageError(`--now must be ISO 8601 with Z or an offset, got "${now}"`);
  const stamp = now ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const { items, problems } = parseWorkItems(readStatus(path));
  if (problems.length > 0) throw new UsageError(problems.map((p) => `${path}:${p.line}: ${p.reason}`).join('\n'));

  const loaded = loadTranscripts(transcripts);
  const result = computeEstimate(items, limitWindows(loaded.texts), Date.parse(stamp));
  if (result.missing) {
    process.stderr.write(`${formatRefusal(result)}\n`);
    return EXIT_REFUSED;
  }
  console.log(formatEstimate(result, { path, now: stamp, transcriptDir: loaded.dir, transcriptCount: loaded.texts.length }));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) fail(err.message);
  throw err;
}
