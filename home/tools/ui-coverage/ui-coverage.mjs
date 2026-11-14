#!/usr/bin/env node
// CLI of the UI coverage matrix: `expand` adds todo cells, `check` decides whether a UI task is done.
// Usage: ui-coverage.mjs expand <matrix.json> [--out <file>]
//        ui-coverage.mjs check <matrix.json> [--results <file>]...    (repeat --results; each file is an array of
//        `{surface,state,locale,width,status,evidence}` records, or an object with a `results` array)
// Exit codes: 0 ok / matrix complete, 1 problems found, 2 usage or setup error (bad flag, unreadable or invalid JSON file).
// Invariants: logic lives in lib/ (pure); this file only parses arguments, reads and writes files and prints. `check`
// never writes. `expand` refuses to write a structurally broken matrix (exit 1, problems on stderr).
import { readFileSync, writeFileSync } from 'node:fs';
import { checkMatrix } from './lib/check.mjs';
import { expandMatrix } from './lib/cells.mjs';
import { formatReport } from './lib/report.mjs';
import { validateStructure } from './lib/shape.mjs';

const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;
const JSON_INDENT = 2;
const USAGE = 'usage: ui-coverage.mjs expand <matrix.json> [--out <file>] | check <matrix.json> [--results <file>]...';

class UsageError extends Error {}

function fail(message) {
  process.stderr.write(`ui-coverage: ${message}\n`);
  process.exit(EXIT_USAGE);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read JSON from ${path}: ${err.message}`);
  }
}

// Splits argv after the command into positional words and flag values; unknown flags are errors.
function parseArgs(argv, valueFlags) {
  const flags = Object.fromEntries(valueFlags.map((flag) => [flag, []]));
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) positional.push(arg);
    else if (valueFlags.includes(arg) && i + 1 < argv.length) flags[arg].push(argv[(i += 1)]);
    else throw new UsageError(`unknown or incomplete flag ${arg}`);
  }
  return { flags, positional };
}

function matrixPath(positional) {
  if (positional.length !== 1) throw new UsageError(USAGE);
  return positional[0];
}

function recordsFrom(path) {
  const data = readJson(path);
  const records = Array.isArray(data) ? data : data?.results;
  if (!Array.isArray(records)) throw new UsageError(`${path} must hold an array of records or {"results": [...]}`);
  return records;
}

function expand(argv) {
  const { flags, positional } = parseArgs(argv, ['--out']);
  const path = matrixPath(positional);
  const matrix = readJson(path);
  const problems = validateStructure(matrix);
  if (problems.length > 0) {
    process.stderr.write(`${problems.map((p) => `[${p.code}] ${p.message}`).join('\n')}\n`);
    return EXIT_PROBLEMS;
  }
  const expanded = expandMatrix(matrix);
  const target = flags['--out'][0] ?? path;
  writeFileSync(target, `${JSON.stringify(expanded, null, JSON_INDENT)}\n`);
  console.log(`${target}: ${expanded.cells.length - (matrix.cells?.length ?? 0)} cells added, ${expanded.cells.length} in total`);
  return 0;
}

function check(argv) {
  const { flags, positional } = parseArgs(argv, ['--results']);
  const matrix = readJson(matrixPath(positional));
  const records = flags['--results'].flatMap(recordsFrom);
  const result = checkMatrix(matrix, records);
  console.log(formatReport(result));
  return result.problems.length === 0 ? 0 : EXIT_PROBLEMS;
}

const COMMANDS = { expand, check };

const [command, ...rest] = process.argv.slice(2);
if (!Object.hasOwn(COMMANDS, command ?? '')) fail(USAGE);
try {
  process.exitCode = COMMANDS[command](rest);
} catch (err) {
  if (err instanceof UsageError) fail(err.message);
  throw err;
}
