#!/usr/bin/env node
// Refresh of the status line's estimate cache: computes the estimate for one STATUS.md with the estimate lib and stores the short
// segment text. Started detached by lib/segment-cache.mjs (never by the status line render itself, it reads transcripts and is slow).
// Usage: statusline-cache.mjs <STATUS.md>   (run in the project folder: its transcripts are the project's)
// Writes ~/.claude/state/estimate-segment/<id>.json (see lib/segment-cache.mjs); prints nothing. Exit 0 when the cache was written
// (also when the tool refused or could not read the table: the cache then holds text null); exit 1 on a bad call or a failed write.
// Invariants: the text is "done ~<finish clock>" (e.g. `done ~14:50-16:15`, `done ~Sun 00:50-02:25` when the low end is not
// today) from the lib's own finishClock, scaled by the calibration log's factors (read only: this script never writes the log),
// never computed here; no text after a refusal or a delivery. The file's
// mtime and size are read BEFORE the estimate so a file edited meanwhile is seen as changed by the next render.
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { UsageError, estimateFile } from './lib/from-files.mjs';
import { applyFactors, calibrationFactors } from './lib/calibration.mjs';
import { readLog } from './lib/estimate-log.mjs';
import { finishClock, printedBounds } from './lib/report.mjs';
import { cacheDir, writeEntry } from './lib/segment-cache.mjs';

/** The segment text and the printed high end (epoch ms), both null when the tool refuses, the job is delivered or the table cannot be read. */
function segment(statusPath) {
  const none = { text: null, highMs: null };
  try {
    const { result } = estimateFile(statusPath, { cwd: dirname(statusPath) });
    if (result.refused || result.delivered !== undefined) return none;
    const shown = applyFactors(result, calibrationFactors(readLog(statusPath)));
    return { text: `done ~${finishClock(shown)}`, highMs: printedBounds(shown).high };
  } catch (err) {
    if (err instanceof UsageError) return none; // a table or transcript folder the tool rejects: no segment, never an error text
    throw err;
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
const { text, highMs } = segment(statusPath);
const stored = writeEntry(cacheDir(), statusPath, { path: statusPath, text, highMs, mtimeMs, size, computedAt: Date.now(), refreshStartedAt: startedAt });
process.exitCode = stored ? 0 : 1;
