#!/usr/bin/env node
// CLI of `refs`: finds config entries that point at paths that do not exist (tsconfig aliases, package entries,
// Dockerfile COPY, CI working-directory, compose env_file, links in markdown, ...). Imports in source code are the
// typecheck's job and are not read; see README.md for what is and is not checked.
// Usage: refs.mjs check [dir] [--json] [--no-hints]
// Exit codes: 0 no findings, 1 findings, 2 usage error or unreadable directory. Hints never change the exit code.
// Invariants: logic lives in lib/; this file parses arguments, prints and sets the exit code. It never writes.
import { statSync } from 'node:fs';
import { formatJson, formatText } from './lib/report.mjs';
import { scanDirectory } from './lib/scan.mjs';

const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;
const USAGE = 'usage: refs.mjs check [dir] [--json] [--no-hints]';

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'check') throw new UsageError(USAGE);
  const options = { dir: null, json: false, hints: true };
  for (const arg of rest) {
    if (arg === '--json') options.json = true;
    else if (arg === '--no-hints') options.hints = false;
    else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}. ${USAGE}`);
    else if (options.dir === null) options.dir = arg;
    else throw new UsageError(`one folder only. ${USAGE}`);
  }
  options.dir ??= process.cwd();
  return options;
}

function scan(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`${dir} is not a folder.`);
  try {
    return scanDirectory(dir);
  } catch (error) {
    throw new UsageError(`cannot read ${dir}: ${error.message}`);
  }
}

function main(argv) {
  try {
    const options = parseArgs(argv);
    const result = scan(options.dir);
    if (!options.hints) result.hints = [];
    console.log(options.json ? formatJson(result) : formatText(result));
    return result.findings.length > 0 ? EXIT_FINDINGS : 0;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`refs: ${error.message}`);
    return EXIT_USAGE;
  }
}

process.exitCode = main(process.argv.slice(2));
