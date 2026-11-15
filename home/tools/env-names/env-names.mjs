#!/usr/bin/env node
// CLI of env-names: compares the environment variables of a project by NAME, never by value.
// Usage: env-names.mjs list [dir] [--json] [--save <file>] [--wrapper <fn>]...
//        env-names.mjs diff <old-snapshot.json> [dir] [--json] [--wrapper <fn>]...
//        dir          folder to scan (default: the current folder)
//        --json       print the full structure instead of the text report
//        --save       also write that structure (a snapshot: version, root, generatedAt, wrappers) to <file>; it never
//                     replaces an existing path (add --overwrite to replace a regular file) and refuses a file name that
//                     looks like an env file
//        --wrapper    name of a function whose first string argument is a variable name, e.g. getEnvVariable (repeatable)
// Exit codes: list 0, or 2 (usage error, unreadable folder); diff 0 nothing changed, 1 something changed, 2 usage error or
// a snapshot that is unreadable, of the wrong shape or the wrong version (refused, never guessed).
// Invariants: no value of any env file reaches stdout, stderr or a snapshot (see lib/env-file-names.mjs); error messages
// are written by this tool and never carry file content. This file only parses arguments, calls lib/ and prints.
import { closeSync, lstatSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { WRAPPER_NAME } from './lib/code-reads.mjs';
import { collectProject } from './lib/collect.mjs';
import { diffSnapshots } from './lib/diff.mjs';
import { formatDiff, formatList } from './lib/report.mjs';
import { parseSnapshot } from './lib/snapshot.mjs';
import { isEnvFileName } from './lib/walk.mjs';
import { UsageError } from './lib/usage-error.mjs';

const EXIT_USAGE = 2;
const USAGE = 'usage: env-names.mjs list [dir] [--json] [--save <file> [--overwrite]] [--wrapper <fn>]... | diff <old-snapshot.json> [dir] [--json] [--wrapper <fn>]...';
const COMMANDS = ['list', 'diff'];

function parseArgs(argv) {
  const options = { json: false, overwrite: false, save: undefined, wrappers: [], positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) options.positional.push(arg);
    else if (arg === '--json') options.json = true;
    else if (arg === '--overwrite') options.overwrite = true;
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

/** Writes the snapshot. A new file only (`wx` fails on any existing path, a symlink included); `--overwrite` replaces a regular file. */
function saveSnapshot(path, data, overwrite) {
  if (isEnvFileName(basename(path))) throw new UsageError(`refusing to save a snapshot under the env-file-like name ${basename(path)}`);
  let fd;
  try {
    if (overwrite && !(lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? true)) throw new UsageError(`refusing to overwrite ${path}: it is not a regular file`);
    fd = openSync(path, overwrite ? 'w' : 'wx');
    writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(err.code === 'EEXIST' ? `refusing to save over ${path}: it exists (--overwrite replaces a regular file)` : `cannot write ${path} (${err.code ?? 'error'})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function runList(options) {
  if (options.positional.length > 1) throw new UsageError(USAGE);
  const data = collectProject(scanRoot(options.positional[0]), options.wrappers, new Date());
  if (options.save !== undefined) saveSnapshot(options.save, data, options.overwrite);
  console.log(options.json ? JSON.stringify(data, null, 2) : formatList(data));
  return 0;
}

/** Reads a snapshot. Only a regular file is opened (a FIFO would block, a symlink could lead anywhere). */
function readSnapshotFile(path) {
  let text;
  try {
    if (!lstatSync(path).isFile()) throw new UsageError(`snapshot ${path} is not a regular file`);
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`cannot read snapshot ${path} (${err.code ?? 'error'})`);
  }
  return parseSnapshot(text);
}

/** The wrappers a diff scans with: the snapshot's own, so the two scans are comparable; a different `--wrapper` set is refused. */
function wrappersForDiff(old, requested) {
  const saved = old.wrappers ?? [];
  const asked = [...new Set(requested)].sort();
  if (asked.length > 0 && asked.join(' ') !== saved.join(' ')) {
    throw new UsageError(`this snapshot was saved with --wrapper ${saved.join(', ') || '(none)'}; diff uses those, so drop --wrapper or save a new snapshot`);
  }
  return saved;
}

function runDiff(options) {
  if (options.positional.length < 1 || options.positional.length > 2 || options.save !== undefined) throw new UsageError(USAGE);
  const old = readSnapshotFile(options.positional[0]);
  const now = collectProject(scanRoot(options.positional[1]), wrappersForDiff(old, options.wrappers), new Date());
  const diff = diffSnapshots(old, now);
  console.log(options.json ? JSON.stringify(diff, null, 2) : formatDiff(diff));
  return diff.changed ? 1 : 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new UsageError(USAGE);
  const options = parseArgs(rest);
  return command === 'list' ? runList(options) : runDiff(options);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  process.stderr.write(`env-names: ${err.message}\n`);
  process.exitCode = EXIT_USAGE;
}
