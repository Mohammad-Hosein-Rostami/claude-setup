#!/usr/bin/env node
// Refresh of the status line's estimate cache: computes the estimate for one STATUS.md with the estimate lib and stores the short
// segment text. Started detached by lib/segment-cache.mjs (never by the status line render itself, it reads transcripts and is slow).
// Usage: statusline-cache.mjs <STATUS.md>   (run in the project folder: its transcripts are the project's)
// Writes ~/.claude/state/estimate-segment/<id>.json (see lib/segment-cache.mjs); prints nothing. Exit 0 when the cache was written
// (also when the tool refused or could not read the table: the cache then holds a `done ? <cause>` marker); exit 1 on a bad call or a failed write.
// Invariants: the text and its kind come from lib/segment-text.mjs (`done ~14:50-16:15`, `done >=17:10`, `delivered 17:54`, or
// `done ? <cause>` after a refusal or an error), the finish scaled by the calibration log's factors (read only: this script never
// writes the log), never computed here. The file's mtime and size are read BEFORE the estimate so a file edited meanwhile is seen as
// changed by the next render.
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { estimateFile } from './lib/from-files.mjs';
import { applyFactors, calibrationFactors, phaseOf, phaseOfState } from './lib/calibration.mjs';
import { readLog } from './lib/estimate-log.mjs';
import { cacheDir, writeEntry } from './lib/segment-cache.mjs';
import { errorSegment, refusalSegment, resultSegment } from './lib/segment-text.mjs';

/** The segment {kind, text, highMs} for a STATUS.md: its finish, its delivery, or why there is none; never throws. */
function segment(statusPath) {
  try {
    const highFactorOf = (items, nowMs, state) => (phaseOfState(state) === null ? 1 : calibrationFactors(readLog(statusPath), phaseOfState(state)).high);
    const { result } = estimateFile(statusPath, { cwd: dirname(statusPath), highFactorOf });
    if (result.refused) return refusalSegment(result);
    const phase = phaseOf(result); // null: delivered
    return resultSegment(phase === null ? result : applyFactors(result, calibrationFactors(readLog(statusPath), phase)));
  } catch (err) {
    return errorSegment(err); // a table the tool rejects, or any failure: a marker with a fixed cause, never the error text
  }
}

const argument = process.argv[2];
if (process.argv.length !== 3 || !argument) {
  process.stderr.write('usage: statusline-cache.mjs <STATUS.md>\n');
  process.exit(1);
}
const statusPath = resolve(argument);
const startedAt = Date.now();
const { mtimeMs, size } = statSync(statusPath);
const { kind, text, highMs } = segment(statusPath);
const stored = writeEntry(cacheDir(), statusPath, { path: statusPath, kind, text, highMs, mtimeMs, size, computedAt: Date.now(), refreshStartedAt: startedAt });
process.exitCode = stored ? 0 : 1;
