// PreToolUse(Workflow): refuses a hand-written workflow script that runs `phase('Land')` after a `pipeline(...)` call, the shape that made
// lanes clean at about 62 min land at 134 min (spec-p3 `r9-land-speed`: 45% of landing time was waiting for a land slot). A multi-lane job
// runs through the `build` workflow, which lands each lane inside its own pipeline.
// It also hands the owner's check switch to the setup's own scripts (spec r9-checks-off): `args.checks` is set to the categories on for this
// session (lib/checks-on.mjs), replacing whatever the caller passed, so only the owner's /check turns a workflow's test, review, ui or
// probe stages on; the scripts pass it to their children. Changed input goes back as `updatedInput` with "allow" (hooks docs: updatedInput
// "Combine with \"allow\" to auto-approve"; without a decision auto mode can deny the changed call); only setup scripts get it.
// Exports: scriptVerdict(toolInput, { setupDir }) -> { deny: string } | null, landAfterPipeline(text) -> boolean,
//   withChecks(toolInput, on, { setupDir }) -> the changed tool input, or null when nothing changes.
// Input (probe N13 open): the first call passes the script inline (`script`), later calls pass `scriptPath`; the check reads the inline
//   text, else the file at `scriptPath`, and denies with a reason when a `scriptPath` is given but cannot be read (fail closed). A call
//   with neither (a named workflow) and the setup's own scripts (real path inside its workflows folder, next to this hooks folder) pass.
// Invariants: never blocks on its own error except the unreadable `scriptPath` above: any other failure is one stderr line and exit 0.
//   The stdin JSON is read up to MAX_INPUT_BYTES and a script file up to MAX_SCRIPT_BYTES (larger: denied, it cannot be checked whole).
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { onCategories, sessionIdOf } from './lib/checks-on.mjs';

const MAX_INPUT_BYTES = 8 << 20;
const MAX_SCRIPT_BYTES = 4 << 20;
const PIPELINE_CALL = /\bpipeline\s*\(/;
const LAND_PHASE = /\bphase\s*\(\s*(['"`])Land\1/g;
const REASON = 'This workflow script runs phase(\'Land\') after a pipeline: every lane then waits for the slowest before it lands '
  + '(45% of landing time in round 4). Run a multi-lane job through the `build` workflow, which lands each lane inside its pipeline.';

/** Drops `//` line comments and block comments, so a comment naming the shape does not count. */
const withoutComments = (text) => text.replace(/\/\*[^]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

/**
 * True when a `phase('Land')` call comes after the first `pipeline(` call.
 * @param {string} text the script source
 * @returns {boolean}
 */
export function landAfterPipeline(text) {
  const code = withoutComments(text);
  const pipelineAt = code.search(PIPELINE_CALL);
  if (pipelineAt < 0) return false;
  for (const match of code.matchAll(LAND_PHASE)) if (match.index > pipelineAt) return true;
  return false;
}

/** The file's text, or null when it cannot be read as a regular file of at most MAX_SCRIPT_BYTES. */
function readScript(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return read === stat.size ? buffer.toString('utf8') : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const isInside = (path, folder) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The verdict for one Workflow tool input.
 * @param {object} toolInput the hook's `tool_input`
 * @param {{ setupDir: string }} options the setup's workflows folder (its scripts pass)
 * @returns {{ deny: string } | null}
 */
export function scriptVerdict(toolInput, { setupDir }) {
  const input = toolInput !== null && typeof toolInput === 'object' ? toolInput : {};
  if (typeof input.script === 'string' && input.script !== '') return landAfterPipeline(input.script) ? { deny: REASON } : null;
  if (typeof input.scriptPath !== 'string' || input.scriptPath === '') return null;
  const real = realOrNull(input.scriptPath);
  const setup = realOrNull(setupDir);
  if (real !== null && setup !== null && isInside(real, setup)) return null;
  const text = real === null ? null : readScript(real);
  if (text === null) return { deny: `workflow-script-check: cannot read the script at ${JSON.stringify(input.scriptPath.slice(0, 300))} to check it; pass the script inline or a readable file.` };
  return landAfterPipeline(text) ? { deny: REASON } : null;
}

/**
 * The tool input of a setup script with `args.checks` set to the categories on (args given as an object or as JSON text).
 * @param {object} toolInput the hook's `tool_input`
 * @param {string[]} on the categories on for this session
 * @param {{ setupDir: string }} options the setup's workflows folder
 * @returns {object | null} null when the script is not the setup's, the args cannot be read, or nothing would change
 */
export function withChecks(toolInput, on, { setupDir }) {
  const real = typeof toolInput?.scriptPath === 'string' ? realOrNull(toolInput.scriptPath) : null;
  const setup = realOrNull(setupDir);
  if (real === null || setup === null || !isInside(real, setup)) return null;
  let args = toolInput.args ?? {};
  const asText = typeof args === 'string';
  try {
    if (asText) args = JSON.parse(args);
  } catch {
    return null; // the script's own checkArgs reports bad args
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  if (on.length === 0 && !('checks' in args)) return null;
  const changed = { ...args, checks: on };
  return { ...toolInput, args: asText ? JSON.stringify(changed) : changed };
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return;
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (input?.tool_name !== 'Workflow') return;
  const setupDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
  const verdict = scriptVerdict(input.tool_input, { setupDir });
  if (verdict === null) {
    const updatedInput = withChecks(input.tool_input, onCategories(sessionIdOf(input)), { setupDir });
    if (updatedInput !== null) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'the owner\'s /check categories handed to the workflow', updatedInput } }));
    return;
  }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.deny } }));
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => console.error(`workflow-script-check: ${error.message}`));
}
