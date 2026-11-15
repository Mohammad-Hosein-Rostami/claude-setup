#!/usr/bin/env node
// CLI of env-names: compares the environment variables of a project by NAME, never by value.
// Usage: env-names.mjs list [dir] [--json] [--save <file>] [--wrapper <fn>]...
//        env-names.mjs diff <old-snapshot.json> [dir] [--json] [--wrapper <fn>]...
//        dir          folder to scan (default: the current folder)
//        --json       print the full structure instead of the text report
//        --save       also write that structure (a snapshot: version, root, generatedAt, wrappers) to <file>; it never
//                     replaces an existing path (--overwrite replaces a snapshot this tool saved, never a link) and
//                     refuses a file name that looks like an env file, in any letter case
//        --wrapper    name of a function whose first string argument is a variable name, e.g. getEnvVariable (repeatable)
// Exit codes: list 0, or 2 (usage error, unreadable folder); diff 0 nothing changed, 1 something changed, 2 usage error or
// a snapshot that is unreadable, of the wrong shape or the wrong version (refused, never guessed).
// Invariants: no value of any env file reaches stdout, stderr or a snapshot (see lib/env-file-names.mjs); error messages
// are written by this tool and never carry file content. This file only parses arguments, calls lib/ and prints.
import { closeSync, constants as fsConstants, fstatSync, ftruncateSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { WRAPPER_NAME } from './lib/code-reads.mjs';
import { collectProject } from './lib/collect.mjs';
import { diffSnapshots } from './lib/diff.mjs';
import { formatDiff, formatList } from './lib/report.mjs';
import { isToolSnapshot, parseSnapshot } from './lib/snapshot.mjs';
import { isEnvFileName } from './lib/walk.mjs';
import { UsageError } from './lib/usage-error.mjs';

const EXIT_USAGE = 2;
const USAGE = 'usage: env-names.mjs list [dir] [--json] [--save <file> [--overwrite]] [--wrapper <fn>]... | diff <old-snapshot.json> [dir] [--json] [--wrapper <fn>]...';
const COMMANDS = ['list', 'diff'];
// Symlinks are never followed and a FIFO never blocks the open; both are 0 where the platform has no such flag.
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = fsConstants.O_NONBLOCK ?? 0;
const SNAPSHOT_FILE_MODE = 0o644;

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

/** Opens an existing snapshot for replacing: never through a symlink, only a regular file, only one saved by this tool. */
function openExistingSnapshot(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDWR | NO_FOLLOW | NON_BLOCKING);
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new UsageError(`refusing to overwrite ${path}: it is not a regular file`);
    if (!isToolSnapshot(readFileSync(fd, 'utf8'))) throw new UsageError(`refusing to overwrite ${path}: it is not a snapshot saved by this tool`);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return fd;
}

/**
 * Writes the snapshot. A new file is created exclusively (fails on any existing path, a symlink included); `--overwrite` replaces
 * only a regular file that already holds one of this tool's snapshots. The name is checked without regard to case, because a
 * case-insensitive disk would make `.ENV` the real `.env`.
 */
function saveSnapshot(path, data, overwrite) {
  if (isEnvFileName(basename(path).toLowerCase())) throw new UsageError(`refusing to save a snapshot under the env-file-like name ${basename(path)}`);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  let fd;
  try {
    fd = overwrite ? openExistingSnapshot(path) : undefined;
    if (fd !== undefined) ftruncateSync(fd, 0);
    else fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW, SNAPSHOT_FILE_MODE);
    writeSync(fd, text, 0);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (err.code === 'EEXIST') throw new UsageError(`refusing to save over ${path}: it exists (--overwrite replaces a snapshot saved by this tool)`);
    if (err.code === 'ELOOP') throw new UsageError(`refusing to save through the symlink ${path}`);
    throw new UsageError(`cannot write ${path} (${err.code ?? 'error'})`);
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

/** Reads a snapshot. Only a regular file is read: opened without following a symlink and without blocking on a FIFO. */
function readSnapshotFile(path) {
  let fd;
  let text;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
    if (!fstatSync(fd).isFile()) throw new UsageError(`snapshot ${path} is not a regular file`);
    text = readFileSync(fd, 'utf8');
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(err.code === 'ELOOP' ? `snapshot ${path} is not a regular file (a symlink)` : `cannot read snapshot ${path} (${err.code ?? 'error'})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
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
