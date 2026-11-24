#!/usr/bin/env node
// CLI of the UI coverage matrix: `init` writes a skeleton matrix, `expand` adds todo cells, `scaffold` writes the
// ui-check batch states skeleton, `check` decides whether a UI task is done.
// Usage: ui-coverage.mjs init <matrix.json> --locales en:ltr,fa:rtl --widths 320,768,1280 --surfaces login,signup [--frames frames.json]
//        (refuses to overwrite an existing file; the skeleton has TODO placeholders that `check` rejects; --frames, a file
//        written by `ui-check figma-frames`, adds the `figma` section and every frame as unmapped)
//        ui-coverage.mjs expand <matrix.json> [--out <file>]    (also appends the frames of the matrix's figma.framesFile that the matrix lacks)
//        ui-coverage.mjs check <matrix.json> [--results <file>]... [--verbose]    (--verbose lists every problem, not the groups; repeat --results; each file is an array of
//        `{surface,state,locale,width,status,evidence}` records, or an object with a `results` array)
//        ui-coverage.mjs scaffold <matrix.json> [--out states.json]     (states skeleton for every open cell; keeps an existing --out's entries)
//        ui-coverage.mjs states                                         (prints the default states per control class)
//        ui-coverage.mjs conditions [--project DIR] [--zoom N --pixel-ratio N --theme light|dark --data TEXT [--rtl fa,ar] [--schemes light,dark]]
//        (records the owner's viewing conditions once per project; without value flags prints them)
// Exit codes: 0 ok / matrix complete, 1 problems found, 2 usage or setup error (bad flag, unreadable or invalid JSON file).
// Invariants: logic lives in lib/ (pure); this file only parses arguments, reads and writes files and prints. `check`
// never writes; it resolves relative evidence and mountedAt paths from the matrix file's directory (or its `root`). `expand` refuses to write a structurally broken matrix (exit 1, problems on stderr).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { checkMatrix } from './lib/check.mjs';
import { expandMatrix } from './lib/cells.mjs';
import { readFramesFile } from './lib/frames.mjs';
import { conditionsFile, describeConditions, parseConditions, readConditions, writeConditions } from './lib/conditions.mjs';
import { initMatrix, parseBreakpoints, parseLocales, parseRule, parseSchemes, parseSurfaces, parseWidths } from './lib/init.mjs';
import { formatReport } from './lib/report.mjs';
import { validateStructure } from './lib/shape.mjs';
import { scaffoldStates } from './lib/scaffold.mjs';
import { describeStates } from './lib/states.mjs';

const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;
const JSON_INDENT = 2;
const DEFAULT_STATES_FILE = 'states.json';
const USAGE = 'usage: ui-coverage.mjs init <matrix.json> --locales en:ltr,fa:rtl --widths 320,768 --surfaces login,signup [--frames frames.json] [--rule strict] [--breakpoints 600,900] [--schemes light,dark] | conditions [--project DIR] [--zoom 100 --pixel-ratio 2 --theme light --data TEXT [--rtl fa] [--schemes light,dark]] | expand <matrix.json> [--out <file>] | scaffold <matrix.json> [--out <states.json>] | check <matrix.json> [--results <file>]... [--verbose] | states';

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
function parseArgs(argv, valueFlags, switches = []) {
  const flags = Object.fromEntries([...valueFlags, ...switches].map((flag) => [flag, []]));
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) positional.push(arg);
    else if (switches.includes(arg)) flags[arg].push(true);
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

// The frames file of `init --frames`, with its path as the matrix names it (relative to the matrix); null when the flag is absent.
function framesSourceOf(flag, matrixFile) {
  if (flag === undefined) return null;
  const data = readFramesFile(readText(flag));
  if (data === null) throw new UsageError(`${flag} cannot be read or is not a frames file: write it with ui-check figma-frames`);
  return { path: relative(dirname(resolve(matrixFile)), resolve(flag)), data };
}

// The optional init values; --widths may be left out when a frames file gives the widths.
function initOptions(flags, framesSource) {
  const given = (name) => flags[name][0];
  return {
    widths: given('--widths') === undefined && framesSource ? [] : parseWidths(given('--widths')),
    rule: given('--rule') === undefined ? undefined : parseRule(given('--rule')),
    breakpoints: given('--breakpoints') === undefined ? undefined : parseBreakpoints(given('--breakpoints')),
    schemes: given('--schemes') === undefined ? undefined : parseSchemes(given('--schemes')),
  };
}

function init(argv) {
  const { flags, positional } = parseArgs(argv, ['--locales', '--widths', '--surfaces', '--frames', '--rule', '--breakpoints', '--schemes']);
  const path = matrixPath(positional);
  if (existsSync(path)) throw new UsageError(`${path} already exists; init never overwrites a matrix (delete it or pick another name)`);
  const framesSource = framesSourceOf(flags['--frames'][0], path);
  let matrix;
  try {
    matrix = initMatrix({ locales: parseLocales(flags['--locales'][0]), surfaces: parseSurfaces(flags['--surfaces'][0]), framesSource, ...initOptions(flags, framesSource) });
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }
  writeFileSync(path, `${JSON.stringify(matrix, null, JSON_INDENT)}\n`);
  console.log(`${path}: skeleton with ${matrix.surfaces.length} surfaces and ${matrix.cells.length} todo cells; replace every TODO, list each surface's controls, run expand, then check`);
  console.log(framesSource ? `${framesSource.data.frames.length} frames listed from ${framesSource.path}: map each to cells or mark it notBuilt` : 'no Figma source: frame inventory off');
  if (matrix.breakpoints) console.log(`widths ${matrix.widths.join(', ')}: breakpoints ${matrix.breakpoints.join(', ')}${flags['--breakpoints'].length === 0 ? ' (R118 default, UNCONFIRMED: pass --breakpoints with the theme breakpoints)' : ''}, each -1 and +0`);
  console.log(`rule: ${matrix.rule ?? 'default'}`);
  return 0;
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
  const source = matrix.figma ? readFramesFile(readText(resolve(dirname(path), matrix.figma.framesFile))) : { frames: [] };
  if (source === null) {
    process.stderr.write(`[frame-source] figma.framesFile ${matrix.figma.framesFile} cannot be read or is not a frames file: write it with ui-check figma-frames\n`);
    return EXIT_PROBLEMS;
  }
  const expanded = expandMatrix(matrix, source.frames);
  const target = flags['--out'][0] ?? path;
  writeFileSync(target, `${JSON.stringify(expanded, null, JSON_INDENT)}\n`);
  const framesAdded = matrix.figma ? `, ${(expanded.frames?.length ?? 0) - (matrix.frames?.length ?? 0)} frames added` : '';
  console.log(`${target}: ${expanded.cells.length - (matrix.cells?.length ?? 0)} cells added${framesAdded}, ${expanded.cells.length} in total`);
  return 0;
}

// An existing states file is extended, a missing one is created; an unreadable or invalid one is a usage error (never overwritten).
function existingStates(target) {
  if (!existsSync(target)) return null;
  const data = readJson(target);
  if (typeof data !== 'object' || data === null || !Array.isArray(data.states)) throw new UsageError(`${target} must be a states file: {"defaults": {...}, "states": [...]}`);
  return data;
}

function scaffold(argv) {
  const { flags, positional } = parseArgs(argv, ['--out']);
  const matrix = readJson(matrixPath(positional));
  const problems = validateStructure(matrix);
  if (problems.length > 0) {
    process.stderr.write(`${problems.map((p) => `[${p.code}] ${p.message}`).join('\n')}\n`);
    return EXIT_PROBLEMS;
  }
  const target = flags['--out'][0] ?? DEFAULT_STATES_FILE;
  const { added, ...file } = scaffoldStates(matrix, existingStates(target));
  writeFileSync(target, `${JSON.stringify(file, null, JSON_INDENT)}\n`);
  console.log(`${target}: ${added} entries added, ${file.states.length} in total; fill url, steps and defaults, then run ui-check batch --states ${target}`);
  return 0;
}

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false; // a missing path is the answer "no such file", not an error
  }
};

// Text of a file, or null when there is no such file (a missing mount file is a finding, not an error).
const readText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

function check(argv) {
  const { flags, positional } = parseArgs(argv, ['--results'], ['--verbose']);
  const path = matrixPath(positional);
  const matrix = readJson(path);
  const records = flags['--results'].flatMap(recordsFrom);
  const result = checkMatrix(matrix, records, { baseDir: dirname(path), fileExists: isFile, readText, conditions: projectConditions(dirname(resolve(path))) });
  console.log(formatReport(result, { verbose: flags['--verbose'].length > 0 }));
  return result.problems.length === 0 ? 0 : EXIT_PROBLEMS;
}

// The recorded conditions of a project; a broken file is a usage error, never a silent "not recorded".
function projectConditions(dir) {
  try {
    return readConditions(dir);
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }
}

// `conditions`: with no value flag print the project's recorded conditions; with them, record them (once per project).
function conditions(argv) {
  const { flags, positional } = parseArgs(argv, ['--project', '--zoom', '--pixel-ratio', '--theme', '--data', '--rtl', '--schemes']);
  if (positional.length > 0) throw new UsageError(USAGE);
  const dir = resolve(flags['--project'][0] ?? '.');
  const raw = { zoom: flags['--zoom'][0], pixelRatio: flags['--pixel-ratio'][0], theme: flags['--theme'][0], data: flags['--data'][0], rtl: flags['--rtl'][0], schemes: flags['--schemes'][0] };
  if (Object.values(raw).every((value) => value === undefined)) {
    console.log(describeConditions(projectConditions(dir)));
    return 0;
  }
  let parsed;
  try {
    parsed = parseConditions(raw);
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }
  console.log(`${writeConditions(dir, parsed)}: ${describeConditions(parsed)}`);
  return 0;
}

function states(argv) {
  if (argv.length > 0) throw new UsageError(USAGE);
  console.log(describeStates().join('\n'));
  return 0;
}

const COMMANDS = { init, expand, scaffold, check, conditions, states };

const [command, ...rest] = process.argv.slice(2);
if (!Object.hasOwn(COMMANDS, command ?? '')) fail(USAGE);
try {
  process.exitCode = COMMANDS[command](rest);
} catch (err) {
  if (err instanceof UsageError) fail(err.message);
  throw err;
}
