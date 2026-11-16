#!/usr/bin/env node
// Refresh of the status line's estimate cache: runs the same estimate as the CLI (lib/from-files.mjs estimateFile, recording like a
// CLI run, so both keep and show one committed time) and stores the short segment text. Started detached by lib/segment-cache.mjs
// (never by the status line render itself: it reads transcripts and is slow).
// Usage: statusline-cache.mjs <STATUS.md> [<session-id>]   (the session whose transcripts count; the table's linked sessions also do)
// Writes ~/.claude/state/estimate-segment/<id>.json (see lib/segment-cache.mjs) and the table's file in ~/.claude/state/estimate/;
// prints nothing. Exit 0 when the cache was written (also when the tool refused or could not read the table: the cache then holds a
// `done ? <cause>` marker); exit 1 on a bad call or a failed write.
// Invariants: the text and its kind come from lib/segment-text.mjs, never computed here. The file's mtime and size are read BEFORE
// the estimate so a file edited meanwhile is seen as changed by the next render.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isSessionId } from '../../hooks/lib/session-store.mjs';
import { estimateFile } from './lib/from-files.mjs';
import { cacheDir, writeEntry } from './lib/segment-cache.mjs';
import { errorSegment, resultSegment } from './lib/segment-text.mjs';
import { stateDir } from './lib/table-store.mjs';

/** The segment {kind, text, highMs} for a STATUS.md: its finish, its hand-over, or why there is none; never throws. */
function segment(statusPath, sessionId) {
  try {
    return resultSegment(estimateFile(statusPath, { stateDir: stateDir(), sessionId, record: true }).result);
  } catch (err) {
    return errorSegment(err); // a table the tool rejects, or any failure: a marker with a fixed cause, never the error text
  }
}

const [argument, sessionId, ...rest] = process.argv.slice(2);
if (!argument || rest.length > 0 || (sessionId !== undefined && !isSessionId(sessionId))) {
  process.stderr.write('usage: statusline-cache.mjs <STATUS.md> [<session-id>]\n');
  process.exit(1);
}
const statusPath = resolve(argument);
const startedAt = Date.now();
const { mtimeMs, size } = statSync(statusPath);
const { kind, text, highMs } = segment(statusPath, sessionId);
const stored = writeEntry(cacheDir(), statusPath, { path: statusPath, kind, text, highMs, mtimeMs, size, computedAt: Date.now(), refreshStartedAt: startedAt });
process.exitCode = stored ? 0 : 1;
