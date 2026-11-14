#!/usr/bin/env node
// CLI of `readable`: the mechanical part of the human-first rules (C26, C32, C34, C35). It cannot judge names, needless
// abstraction or whether a document is clear; the reviewer does that (see README.md).
// Usage: readable.mjs check <dir> [--changed [--base <ref>]]
// Exit codes: 0 no findings, 1 findings, 2 usage error (bad flag, missing folder, no git for --changed, bad allow-list file),
// 3 the tool itself crashed (so a crash is never mistaken for findings).
// Invariants: logic lives in lib/ (pure checks); this file parses arguments, prints and sets the exit code. It never writes.
import { statSync } from 'node:fs';
import { UsageError } from './lib/errors.mjs';
import { formatReport } from './lib/report.mjs';
import { runCheck } from './lib/run-check.mjs';

const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;
const EXIT_CRASH = 3;
const USAGE = 'usage: readable.mjs check <dir> [--changed [--base <ref>]]';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'check') throw new UsageError(USAGE);
  const options = { root: null, changed: false, base: undefined };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--changed') options.changed = true;
    else if (arg === '--base') {
      options.base = rest[++i];
      if (!options.base) throw new UsageError('--base needs a ref.');
    } else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}. ${USAGE}`);
    else if (options.root === null) options.root = arg;
    else throw new UsageError(`one folder only. ${USAGE}`);
  }
  if (options.root === null) throw new UsageError(USAGE);
  if (options.base !== undefined && !options.changed) throw new UsageError('--base only works with --changed.');
  if (!statSync(options.root, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`${options.root} is not a folder.`);
  return options;
}

function main(argv) {
  try {
    const findings = runCheck(parseArgs(argv));
    console.log(formatReport(findings));
    return findings.length > 0 ? EXIT_FINDINGS : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return EXIT_USAGE;
    }
    console.error(`readable: crashed: ${error.message}`);
    return EXIT_CRASH;
  }
}

process.exitCode = main(process.argv.slice(2));
