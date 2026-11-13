#!/usr/bin/env node
// Purpose: detached entry point of the checkpoint job, started by the checkpoint hook (hooks/checkpoint.mjs) with the
// session lock already held. Usage: node checkpoint-job.mjs <session-id> <transcript-path> <reason>.
// Exports: none. Exit codes: 0 ok, 1 failed (the error is saved in the session's checkpoint state for `recall status`
// and doctor). Always releases the session lock, also on failure.
import { readCheckpoint, releaseLock, writeCheckpoint } from './lib/checkpoint-state.mjs';
import { runCheckpoint } from './lib/checkpoint.mjs';

const [session, transcript, reason] = process.argv.slice(2);
try {
  await runCheckpoint({ session, transcript, reason });
} catch (error) {
  console.error(`recall checkpoint: ${error.message}`);
  const state = readCheckpoint(session) ?? { session, transcript, offset: 0, notes: 0 };
  writeCheckpoint(session, { ...state, error: { ts: new Date().toISOString(), message: error.message } });
  process.exitCode = 1;
} finally {
  releaseLock(session);
}
