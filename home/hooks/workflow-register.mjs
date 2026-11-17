// PostToolUse(Workflow): records each workflow launch of the session (run id, script path, args digest, name, start time, cwd, STATUS row) in
// ~/.claude/state/workflow-runs/<session>.json, so workflow-resume-notice.mjs can list the runs that did not finish after an exit or a usage-limit stop.
// Exports: registerLaunch(input, { dir, now }) -> boolean.
// Invariants: prints nothing and always exits 0 (it must never change what Claude sees or stop a session); the record logic and its limits live in
// tools/wf-resume/lib/registry.mjs. The stdin JSON is read up to MAX_INPUT_BYTES (it carries an inline script); a larger input is skipped.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defaultRegistryDir, launchRecord, saveRun } from '../tools/wf-resume/lib/registry.mjs';

const MAX_INPUT_BYTES = 8 << 20;

/**
 * @param {object | null} input the PostToolUse hook JSON
 * @param {{ dir: string, now: Date }} options the registry folder and the clock
 * @returns {boolean} true when a record was stored
 */
export function registerLaunch(input, { dir, now }) {
  const record = launchRecord(input, now.toISOString());
  return record !== null && saveRun(dir, record);
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return;
    chunks.push(chunk);
  }
  registerLaunch(JSON.parse(Buffer.concat(chunks).toString('utf8')), { dir: defaultRegistryDir(), now: new Date() });
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`workflow-register: ${error.message}\n`); // never trap a session
  }
  process.exitCode = 0;
}
