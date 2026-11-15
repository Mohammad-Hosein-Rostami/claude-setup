#!/usr/bin/env node
// CLI of env-names: compares the environment variables of a project by NAME, never by value.
// Usage: env-names.mjs list [dir] [--json] [--save <file>] [--wrapper <fn>]...
//        env-names.mjs diff <old-snapshot.json> [dir] [--json] [--wrapper <fn>]...
//        dir          folder to scan (default: the current folder)
//        --json       print the full structure instead of the text report
//        --save       also write that structure (a snapshot: version, root, generatedAt) to <file>
//        --wrapper    name of a function whose first string argument is a variable name, e.g. getEnvVariable (repeatable)
// Exit codes: list 0, or 2 (usage error, unreadable folder); diff 0 nothing changed, 1 something changed, 2 usage error or
// a snapshot that is unreadable, of the wrong shape or the wrong version (refused, never guessed).
// Invariants: no value of any env file reaches stdout, stderr or a snapshot (see lib/env-file-names.mjs); error messages
// are written by this tool and never carry file content. This file only parses arguments, calls lib/ and prints.
import { statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectProject } from './lib/collect.mjs';
import { formatList } from './lib/report.mjs';
import { UsageError } from './lib/usage-error.mjs';

const EXIT_USAGE = 2;
const USAGE = 'usage: env-names.mjs list [dir] [--json] [--save <file>] [--wrapper <fn>]... | diff <old-snapshot.json> [dir] [--json] [--wrapper <fn>]...';
const WRAPPER_NAME = /^[A-Za-z_$][A-Za-z0-9_$.]*$/;
const COMMANDS = ['list', 'diff'];

function parseArgs(argv) {
  const options = { json: false, save: undefined, wrappers: [], positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) options.positional.push(arg);
    else if (arg === '--json') options.json = true;
    else if ((arg === '--save' || arg === '--wrapper') && i + 1 < argv.length) {
      i += 1;
      if (arg === '--save') options.save = argv[i];
      else options.wrappers.push(argv[i]);
    } else throw new UsageError(`unknown or incomplete flag ${arg}`);
  }
  for (const wrapper of options.wrappers) if (!WRAPPER_NAME.test(wrapper)) throw new UsageError(`--wrapper ${wrapper} is not a function name`);
  return options;
}

/** The folder to scan as an absolute path; it must exist and be a folder. */
function scanRoot(dirArg) {
  const root = resolve(dirArg ?? process.cwd());
  let isFolder = false;
  try {
    isFolder = statSync(root).isDirectory();
  } catch {
    isFolder = false; // reported below with the same plain reason as a file
  }
  if (!isFolder) throw new UsageError(`not a folder: ${root}`);
  return root;
}

function saveSnapshot(path, data) {
  try {
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  } catch (err) {
    throw new UsageError(`cannot write ${path} (${err.code ?? 'error'})`);
  }
}

function runList(options) {
  if (options.positional.length > 1) throw new UsageError(USAGE);
  const data = collectProject(scanRoot(options.positional[0]), options.wrappers, new Date());
  if (options.save !== undefined) saveSnapshot(options.save, data);
  console.log(options.json ? JSON.stringify(data, null, 2) : formatList(data));
  return 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new UsageError(USAGE);
  const options = parseArgs(rest);
  if (command === 'list') return runList(options);
  throw new UsageError(USAGE);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  process.stderr.write(`env-names: ${err.message}\n`);
  process.exitCode = EXIT_USAGE;
}
