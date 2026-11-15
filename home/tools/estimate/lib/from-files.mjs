// Reads the files an estimate needs (a STATUS.md and the project's lead transcripts) and returns the computed result.
// Exports: UsageError, estimateFile(path, options) -> { result, inputs, items }.
// Invariants: reads only; never writes. Transcripts are read line by line and never printed. Any unreadable or unparsable input is a
// UsageError whose message names the file (and row line). Shared by estimate.mjs (the CLI) and statusline-cache.mjs (the status line cache).
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { computeEstimate } from './compute.mjs';
import { INSTANT_FORMAT, parseInstant, parseWorkItems } from './items.mjs';
import { limitWindows, projectSlug, resolveTranscriptDir } from './limits.mjs';

const READ_CHUNK_BYTES = 1 << 20;
const MISSING_CODES = ['ENOENT', 'ENOTDIR'];

/** A wrong input (file, cell, flag or folder): the CLI prints its message and exits 2. `problems` = the table problems ({line, reason, id?}), empty for other inputs. */
export class UsageError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.problems = problems;
  }
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
function transcriptFiles(explicitDir, cwd) {
  const root = join(homedir(), '.claude', 'projects');
  if (explicitDir !== undefined && !isDirectory(explicitDir)) throw new UsageError(`--transcripts ${explicitDir} is not a folder that exists`);
  const dir = explicitDir ?? resolveTranscriptDir(cwd, root, isDirectory, homedir()) ?? join(root, projectSlug(cwd));
  if (!isDirectory(dir)) return { dir, names: [] };
  try {
    return { dir, names: readdirSync(dir).filter((name) => name.endsWith('.jsonl')) };
  } catch (err) {
    throw new UsageError(`cannot read transcripts ${dir}: ${err.message}`);
  }
}

/**
 * @param {string} path the STATUS.md to read.
 * @param {{transcripts?: string, now?: string, cwd: string}} options transcripts: explicit transcript folder; now: ISO instant
 *   (default the real clock); cwd: the project folder whose transcripts are used when `transcripts` is not given.
 * @returns {{result: object, inputs: {path: string, now: string, transcriptDir: string, transcriptCount: number}, items: object[]}} the
 *   computeEstimate result (or its refusal), what formatEstimate needs to say where the numbers came from, and the parsed rows
 *   (for scoring the calibration log).
 * @throws {UsageError} when a file, a table cell, `now` or the transcript folder cannot be used.
 */
export function estimateFile(path, { transcripts, now, cwd }) {
  const nowMs = now === undefined ? Date.now() : parseInstant(now);
  if (nowMs === null) throw new UsageError(`--now "${now}" is not a real ISO 8601 instant; accepted: ${INSTANT_FORMAT}`);
  const stamp = now ?? new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z');
  const { items, problems } = parseWorkItems(readStatus(path));
  if (problems.length > 0) throw new UsageError(problems.map((p) => `${path}:${p.line}: ${p.reason}`).join('\n'), problems);

  const { dir, names } = transcriptFiles(transcripts, cwd);
  const windows = limitWindows(names.map((name) => fileLines(join(dir, name))));
  return { result: computeEstimate(items, windows, nowMs), inputs: { path, now: stamp, transcriptDir: dir, transcriptCount: names.length }, items };
}
